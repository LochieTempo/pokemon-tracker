exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const { searchTerm } = event.queryStringParameters || {};
  if (!searchTerm) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'searchTerm required' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }) };
  }

  try {
    const prompt = `Find the current market price in AUSTRALIAN DOLLARS (AUD) for this Pokemon sealed product: "${searchTerm}"

CRITICAL: Australian Pokemon prices are often 2-3x higher than US prices. Do NOT use US prices and convert them to AUD — the result will be far too low and useless.

Search specifically for Australian market data. Try these searches:
1. "${searchTerm}" pokemon "AU $" sold ebay.com.au 2025 2026
2. "${searchTerm}" pokemon price australia AUD 2025 2026
3. "${searchTerm}" pokemon australia sold

Look for:
- Prices mentioned in AUD (AU $XXX format) from Australian buyers/sellers
- eBay Australia completed listing prices
- Australian Pokemon community discussions mentioning prices paid
- If it's an ETB (Elite Trainer Box), search for the complete sealed box price, NOT individual promo cards from inside it

Only return a price if you're confident it's an AUSTRALIAN market price in AUD.
If you can only find US prices, return null — a wrong price is worse than no price.

Respond with ONLY this JSON and nothing else:
{"median": 299.00, "count": 1, "source": "eBay AU"}

If no Australian price found, respond with:
{"median": null, "count": 0}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Anthropic error:', response.status, err.substring(0, 300));
      return { statusCode: 200, headers, body: JSON.stringify({ error: `API error ${response.status}` }) };
    }

    const data = await response.json();
    console.log('stop_reason:', data.stop_reason, 'blocks:', data.content?.length);

    // Extract all text blocks from the response
    const textBlocks = data.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    console.log('Raw text response:', textBlocks.substring(0, 400));

    // Parse the JSON response
    const jsonMatch = textBlocks.match(/\{[^{}]*"median"[^{}]*\}/);
    if (!jsonMatch) {
      console.warn('No JSON found in response');
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'No structured response from model' }) };
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch(e) {
      console.warn('JSON parse failed:', jsonMatch[0]);
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'Could not parse JSON response' }) };
    }

    if (!parsed.median || parsed.median < 10) {
      console.log('No valid price found, median was:', parsed.median);
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'No valid sold prices found' }) };
    }

    console.log('Final price:', parsed.median, 'AUD from', parsed.count, 'sales');
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ median: parsed.median, count: parsed.count || 1 })
    };

  } catch(e) {
    console.error('Handler error:', e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
