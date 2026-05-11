export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      }
    });
  }
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  try {
    const { url } = await req.json();
    if (!url) return new Response(JSON.stringify({ error: 'No URL provided' }), { status: 400 });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return new Response(JSON.stringify({ error: 'API key not configured' }), { status: 500 });

    const fetchHtml = async (pageUrl) => {
      const res = await fetch(pageUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        }
      });
      return res.text();
    };

    const extractFirstImage = (html) => {
      const m = html.match(/content=["']([^"']*cstatic[^"']*\.(?:jpeg|jpg|png|webp)[^"']*)["']/i)
               || html.match(/(https:\/\/[^\s"']+cstatic[^\s"']+\.(?:jpeg|jpg|png|webp))/i);
      if (!m) return '';
      return m[1].split('?')[0] + '?quality=90';
    };

    // Fetch main page
    let rawHtml;
    try { rawHtml = await fetchHtml(url); }
    catch (e) { return new Response(JSON.stringify({ error: `Could not fetch page: ${e.message}` }), { status: 500 }); }

    // Extract color variant URLs directly with regex (reliable, no AI needed)
    const skuMatch = url.match(/\/(\d+)\.[A-Z0-9]+$/);
    let colorUrls = [];
    if (skuMatch) {
      const sku = skuMatch[1];
      const colorRegex = new RegExp(`https://[^\\s"'<>]+/${sku}\\.[A-Z0-9]+`, 'g');
      const found = [...new Set(rawHtml.match(colorRegex) || [])];
      colorUrls = found.filter(u => u.match(/\/\d+\.[A-Z0-9]+$/));
    }
    // fallback: just use current URL
    if (colorUrls.length === 0) colorUrls = [url];

    // Extract color labels from HTML near the URLs
    const getColorLabel = (html, colorUrl) => {
      const suffix = colorUrl.match(/\.([A-Z0-9]+)$/)?.[1] || '';
      // look for text near this URL in HTML
      const idx = html.indexOf(colorUrl);
      if (idx === -1) return suffix;
      const nearby = html.slice(Math.max(0, idx - 200), idx + 200);
      // common pattern: color name before the URL
      const labelMatch = nearby.match(/\[([a-zA-Z][a-zA-Z\s\-]+?)\d+,\d+\s*EUR/);
      return labelMatch ? labelMatch[1].trim() : suffix;
    };

    // Fetch all color pages in parallel for images
    const colorPages = await Promise.all(
      colorUrls.map(async (colorUrl) => {
        try {
          const h = await fetchHtml(colorUrl);
          return { url: colorUrl, html: h, img: extractFirstImage(h) };
        } catch {
          return { url: colorUrl, html: '', img: '' };
        }
      })
    );

    // Use main page HTML for Claude analysis (trimmed)
    const html = rawHtml
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\s{2,}/g, ' ')
      .slice(0, 15000);

    const colors = colorPages.map(cp => ({
      label: getColorLabel(rawHtml, cp.url),
      img: cp.img
    }));
    const selectedColor = colorUrls.findIndex(u => u === url || u.split('?')[0] === url.split('?')[0]);

    const prompt = `Here is the HTML of a product page from a textile/outdoor gear shop (URL: ${url}):
<html>${html}</html>

Extract product information and return ONLY valid JSON, no markdown, no code fences:
{"type":"Outer or Lining or Webbing or Zipper or Foam or Hardware or Other","brand":"brand name or empty","name":"product name","article":"SKU · width e.g. No. 72597 · 150cm","desc":"one sentence max 20 words","specs":[{"k":"Water","v":"..."},{"k":"Weight","v":"..."},{"k":"Width","v":"..."},{"k":"Origin","v":"..."}],"weight":"178 g/m²","weightSub":"imperial or empty","price":"€16.90","priceSub":"/meter","url":"${url}"}
Rules: specs = ONLY Water/Weight/Width/Origin. price = extract exactly as shown e.g. "€16.90". Use — for missing values. Type: Outer=shell fabrics laminates. Lining=internal. Webbing=straps. Zipper=zippers. Foam=padding. Hardware=buckles. Other=else.`;

    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 1024, messages: [{ role: 'user', content: prompt }] })
    });

    if (!apiRes.ok) {
      const err = await apiRes.text();
      return new Response(JSON.stringify({ error: `API error: ${apiRes.status}` }), { status: 500 });
    }

    const data = await apiRes.json();
    const textBlock = data.content.find(b => b.type === 'text');
    if (!textBlock) return new Response(JSON.stringify({ error: 'No response from API' }), { status: 500 });

    let jsonStr = textBlock.text.trim()
      .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    let fabric;
    try { fabric = JSON.parse(jsonStr); }
    catch {
      const m = jsonStr.match(/\{[\s\S]*\}/);
      if (!m) return new Response(JSON.stringify({ error: 'Could not parse product data' }), { status: 500 });
      fabric = JSON.parse(m[0]);
    }

    // Attach colors extracted by regex (reliable) instead of Claude's
    fabric.colors = colors;
    fabric.selectedColor = selectedColor >= 0 ? selectedColor : 0;

    return new Response(JSON.stringify(fabric), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || 'Unknown error' }), { status: 500 });
  }
};
