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
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const { url } = await req.json();
    if (!url) return new Response(JSON.stringify({ error: 'No URL provided' }), { status: 400 });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return new Response(JSON.stringify({ error: 'API key not configured' }), { status: 500 });

    // Fetch main page HTML
    const fetchHtml = async (pageUrl) => {
      const res = await fetch(pageUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        }
      });
      const raw = await res.text();
      return raw.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
               .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
               .replace(/<!--[\s\S]*?-->/g, '')
               .replace(/\s{2,}/g, ' ')
               .slice(0, 20000);
    };

    let html;
    try {
      html = await fetchHtml(url);
    } catch (e) {
      return new Response(JSON.stringify({ error: `Could not fetch page: ${e.message}` }), { status: 500 });
    }

    // Step 1: parse main product data
    const prompt = `Here is the HTML of a product page from a textile/outdoor gear shop (URL: ${url}):

<html>${html}</html>

Extract product information and return ONLY valid JSON, no markdown, no code fences:
{
  "type": "Outer or Lining or Webbing or Zipper or Foam or Hardware or Other",
  "brand": "brand name or empty",
  "name": "product name",
  "article": "SKU and width e.g. No. 72597 · 150cm",
  "desc": "one sentence max 20 words",
  "specs": [{"k":"Water","v":"..."},{"k":"Weight","v":"..."},{"k":"Width","v":"..."},{"k":"Origin","v":"..."}],
  "colors": [{"label":"Color Name","url":"full URL to this color variant page","img":""}],
  "selectedColor": 0,
  "weight": "178 g/m²",
  "weightSub": "imperial or empty",
  "price": "€16.90",
  "priceSub": "/meter",
  "url": "${url}"
}

RULES:
- colors: CRITICAL — search the HTML for ALL anchor tags containing the product SKU number (e.g. 72597) with different color suffixes like .SW .LMNLM .RNGGRN .WLFGR etc. Extract EVERY such link as a color variant. Format: {"label":"color name from link text","url":"https://www.extremtextil.de/en/FULL-PATH/SKU.COLOR","img":""}
- selectedColor: index of color whose URL matches ${url}
- price: find the price shown on page like "€16.90" or "16,90 EUR" — return as "€16.90"
- specs: ONLY these 4 keys: Water, Weight, Width, Origin. No other keys.
- Type: Outer=shell fabrics laminates. Lining=internal fabrics. Webbing=straps tapes. Zipper=zippers. Foam=padding. Hardware=buckles clips. Other=else.
- Use — for missing spec values.`;

    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!apiRes.ok) {
      const err = await apiRes.text();
      return new Response(JSON.stringify({ error: `API error: ${apiRes.status} — ${err}` }), { status: 500 });
    }

    const data = await apiRes.json();
    const textBlock = data.content.find(b => b.type === 'text');
    if (!textBlock) return new Response(JSON.stringify({ error: 'No response from API' }), { status: 500 });

    let jsonStr = textBlock.text.trim()
      .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    console.log('Claude response:', jsonStr.slice(0, 500));
    let fabric;
    try {
      fabric = JSON.parse(jsonStr);
    } catch {
      const m = jsonStr.match(/\{[\s\S]*\}/);
      if (!m) return new Response(JSON.stringify({ error: 'Could not parse product data' }), { status: 500 });
      fabric = JSON.parse(m[0]);
    }

    // Step 2: fetch image for each color variant in parallel
    if (Array.isArray(fabric.colors) && fabric.colors.length > 0) {
      const getFirstImage = async (colorUrl) => {
        if (!colorUrl) return '';
        try {
          const h = await fetchHtml(colorUrl);
          // look for og:image meta tag first (most reliable)
          const ogMatch = h.match(/og:image[^>]*content=["']([^"']+cstatic[^"']+)["']/i)
                       || h.match(/content=["']([^"']+cstatic[^"']+\.(?:jpeg|jpg|png|webp)[^"']*)["']/i);
          if (ogMatch) return ogMatch[1].split('?')[0] + '?quality=90';
          // fallback: first cstatic image
          const imgMatch = h.match(/https:\/\/[^"'\s]+cstatic[^"'\s]+\.(?:jpeg|jpg|png|webp)/i);
          return imgMatch ? imgMatch[0].split('?')[0] + '?quality=90' : '';
        } catch { return ''; }
      };

      const images = await Promise.all(
        fabric.colors.map(c => getFirstImage(c.url || ''))
      );
      fabric.colors = fabric.colors.map((c, i) => ({ label: c.label, img: images[i] || '' }));
    }

    return new Response(JSON.stringify(fabric), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || 'Unknown error' }), { status: 500 });
  }
};
