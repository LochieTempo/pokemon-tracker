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
    const prompt = `I need to find the current median sold price for this Pokemon item on eBay Australia: "${searchTerm}"

Please search the web for recent sold/completed listings. Good search queries to try:
- "${searchTerm} sold ebay.com.au"  
- "${searchTerm} ebay australia completed listings"

From the search results, collect all individual sold prices in AUD. Rules:
- Only AUD prices (ignore USD, GBP etc)
- Only single item sales (ignore bundle listings of 2+ items)
- Only prices above $10 AUD
- Focus on the most recent sales

After searching, respond with ONLY a valid JSON object and nothing else — no explanation, no markdown, just the JSON:
{"median": 599.00, "count": 8}

Where median is the median AUD sold price rounded to 2 decimal places, and count is how many individual prices you found.
If you found no valid sold prices, respond with exactly: {"median": null, "count": 0}`;

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
