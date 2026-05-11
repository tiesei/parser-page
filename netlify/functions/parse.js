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

    const prompt = `Fetch and parse this product page: ${url}

This is a fabric/material product from a textile or outdoor gear shop.
Return ONLY valid JSON — no markdown, no code fences, no explanation:
{
  "type": one of: "Outer" | "Lining" | "Webbing" | "Zipper" | "Foam" | "Hardware" | "Other",
  "brand": "brand name or empty string",
  "name": "product name",
  "article": "article number and width if available, e.g. No. 12345 · 140cm",
  "desc": "one sentence max 20 words: material composition, construction, key feature",
  "specs": [
    {"k":"Water","v":"..."},
    {"k":"Weight","v":"..."},
    {"k":"Width","v":"..."},
    {"k":"Origin","v":"..."}
  ],
  "colors": [{"label":"Color Name","img":"full image URL or empty string"}],
  "selectedColor": 0,
  "weight": "XXX g/m² or g/m or similar",
  "weightSub": "imperial equivalent or empty string",
  "price": "€XX.XX or $XX.XX",
  "priceSub": "/meter or /piece or /set",
  "url": "${url}"
}

Rules for type classification:
- Outer: external shell fabrics, laminates, ripstop, sailcloth
- Lining: internal fabrics, liners, taffeta
- Webbing: straps, tapes, ribbons
- Zipper: zippers, sliders, zipper tape
- Foam: foam padding, cushioning
- Hardware: buckles, clips, rings, hooks
- Other: anything else

Use actual image URLs from the page if available. If spec not found use "—".`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!res.ok) {
      const err = await res.text();
      return new Response(JSON.stringify({ error: `API error: ${res.status}` }), { status: 500 });
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
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || 'Unknown error' }), { status: 500 });
  }
};

export const config = { path: '/api/parse' };
