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
    const { url, html } = await req.json();
    if (!url || !html) return new Response(JSON.stringify({ error: 'Missing url or html' }), { status: 400 });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return new Response(JSON.stringify({ error: 'API key not configured' }), { status: 500 });

    const prompt = `Here is the HTML of a product page from a textile/outdoor gear shop (URL: ${url}):

<html>${html}</html>

Extract product information and return ONLY valid JSON, no markdown, no code fences:
{"type":"Outer or Lining or Webbing or Zipper or Foam or Hardware or Other","brand":"brand or empty","name":"product name","article":"SKU and width e.g. No. 12345 · 140cm","desc":"one sentence max 20 words","specs":[{"k":"Water","v":"..."},{"k":"Weight","v":"..."},{"k":"Width","v":"..."},{"k":"Origin","v":"..."}],"colors":[{"label":"Color Name","img":"image URL or empty"}],"selectedColor":0,"weight":"XXX g/m2","weightSub":"imperial or empty","price":"EUR XX.XX","priceSub":"/meter or /piece","url":"${url}"}
Type: Outer=shell fabrics laminates. Lining=internal fabrics. Webbing=straps tapes. Zipper=zippers. Foam=padding. Hardware=buckles clips. Other=else. Extract all colors with images. Use dash for missing specs.`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 4096,
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
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || 'Unknown error' }), { status: 500 });
  }
};

export const config = { path: '/api/parse' };
