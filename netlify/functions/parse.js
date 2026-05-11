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

    // Fetch HTML server-side
    let html = '';
    try {
      const pageRes = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        }
      });
      const raw = await pageRes.text();
      html = raw.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                .replace(/<!--[\s\S]*?-->/g, '')
                .replace(/\s{2,}/g, ' ')
                .slice(0, 20000);
    } catch (fetchErr) {
      return new Response(JSON.stringify({ error: `Could not fetch page: ${fetchErr.message}` }), { status: 500 });
    }

    const prompt = `Here is the HTML of a product page from a textile/outdoor gear shop (URL: ${url}):

<html>${html}</html>

Extract product information and return ONLY valid JSON, no markdown, no code fences, no comments:
{
  "type": "Outer or Lining or Webbing or Zipper or Foam or Hardware or Other",
  "brand": "brand name or empty string",
  "name": "product name",
  "article": "article number and width e.g. No. 72597 · 150cm",
  "desc": "one sentence max 20 words describing material and key feature",
  "specs": [
    {"k":"Water","v":"value or —"},
    {"k":"Weight","v":"value or —"},
    {"k":"Width","v":"value or —"},
    {"k":"Origin","v":"value or —"}
  ],
  "colors": [
    {"label":"Color Name","img":"https://... full image URL"}
  ],
  "selectedColor": 0,
  "weight": "178 g/m²",
  "weightSub": "imperial or empty",
  "price": "€16.90",
  "priceSub": "/meter",
  "url": "${url}"
}

IMPORTANT RULES:
- colors: find ALL color variants on the page (look for color swatches, variant links, color options). For each color include its name and a product image URL (look for img src with cstatic.com or similar CDN). selectedColor = index of color matching the URL.
- price: extract the actual price number shown (e.g. €16.90, not just "16,90 EUR")
- article: use the article/SKU number from the page
- Type rules: Outer=shell fabrics laminates ripstop. Lining=internal fabrics liners. Webbing=straps tapes. Zipper=zippers sliders. Foam=padding. Hardware=buckles clips rings. Other=else.
- Use — for any missing spec value.`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
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

    if (!res.ok) {
      const err = await res.text();
      return new Response(JSON.stringify({ error: `API error: ${res.status} — ${err}` }), { status: 500 });
    }

    const data = await res.json();
    const textBlock = data.content.find(b => b.type === 'text');
    if (!textBlock) return new Response(JSON.stringify({ error: 'No response from API' }), { status: 500 });

    let jsonStr = textBlock.text.trim()
      .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    let fabric;
    try {
      fabric = JSON.parse(jsonStr);
    } catch {
      const m = jsonStr.match(/\{[\s\S]*\}/);
      if (!m) return new Response(JSON.stringify({ error: 'Could not parse product data' }), { status: 500 });
      fabric = JSON.parse(m[0]);
    }

    return new Response(JSON.stringify(fabric), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || 'Unknown error' }), { status: 500 });
  }
};

export const config = { path: '/api/parse' };
