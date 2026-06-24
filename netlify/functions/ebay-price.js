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
    const prompt = `Find the current market price in AUD for this single Pokemon item: "${searchTerm}"

Search PriceCharting.com first — it's the most accurate source. Search: site:pricecharting.com "${searchTerm}"

Also try Australian Pokemon price sources if needed.

Important rules:
- Use the "New/Sealed" price from PriceCharting for sealed products
- NEVER divide a lot or bundle price (e.g. if you see "8x lot sold for $1200", ignore it completely — do not divide)
- Only use prices for SINGLE individual items
- Do NOT use StockX "Lowest Ask" prices — those are asking prices not sold prices
- Prefer AUD prices. If only USD available, convert using 1 USD = 1.55 AUD
- The price should be realistic for an Australian Pokemon collector (typically $30-$2000 AUD range)

Respond with ONLY this JSON and nothing else:
{"median": 599.00, "count": 1, "source": "PriceCharting"}

If you cannot find any price, respond with:
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
