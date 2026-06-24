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
    // Build the exact eBay AU sold listings URL so the model searches the right place
    const query = encodeURIComponent(searchTerm);
    const ebayUrl = `https://www.ebay.com.au/sch/i.html?_nkw=${query}&LH_Sold=1&LH_Complete=1&_sop=13`;

    const prompt = `Fetch this eBay Australia sold listings page and tell me the median sold price in AUD:
${ebayUrl}

Rules:
- Only use prices from SINGLE item sales (ignore listings selling 2, 3 or more together)
- Only use AUD prices
- Calculate the median of the prices you find
- Reply with ONLY a single number (the median AUD price). No dollar sign, no explanation, no other text.
- If the page has no sold listings, reply with exactly: null`;

    // Step 1: Force a web search
    const step1 = await fetch('https://api.anthropic.com/v1/messages', {
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
        tool_choice: { type: 'any' }, // Force tool use
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!step1.ok) {
      const err = await step1.text();
      console.error('Anthropic step1 error:', step1.status, err.substring(0, 300));
      return { statusCode: 200, headers, body: JSON.stringify({ error: `API error: ${step1.status}` }) };
    }

    const data1 = await step1.json();
    console.log('Step1 stop_reason:', data1.stop_reason, 'content blocks:', data1.content?.length);

    // If model returned text directly (shouldn't happen with tool_choice: any, but handle it)
    if (data1.stop_reason === 'end_turn') {
      const text = data1.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
      console.log('Direct text response:', text.substring(0, 200));
      const match = text.match(/\b(\d[\d,]*\.?\d{0,2})\b/);
      if (match) {
        const price = parseFloat(match[1].replace(/,/g, ''));
        if (price > 0) return { statusCode: 200, headers, body: JSON.stringify({ median: price, count: 1 }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'No price in response: ' + text.substring(0, 100) }) };
    }

    // Step 2: Continue with tool results so model can give final answer
    const messages = [
      { role: 'user', content: prompt },
      { role: 'assistant', content: data1.content }
    ];

    // Add tool results
    const toolResults = data1.content
      .filter(b => b.type === 'tool_use')
      .map(b => ({
        type: 'tool_result',
        tool_use_id: b.id,
        content: b.type === 'tool_use' ? 'Search completed' : ''
      }));

    if (toolResults.length) {
      messages.push({ role: 'user', content: toolResults });
    }

    const step2 = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 256,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages
      })
    });

    if (!step2.ok) {
      const err = await step2.text();
      console.error('Anthropic step2 error:', step2.status, err.substring(0, 300));
      return { statusCode: 200, headers, body: JSON.stringify({ error: `API step2 error: ${step2.status}` }) };
    }

    const data2 = await step2.json();
    const finalText = data2.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();

    console.log('Search term:', searchTerm, '→ Final response:', finalText.substring(0, 200));

    if (!finalText || finalText.toLowerCase().includes('null')) {
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'No sold listings found' }) };
    }

    // Extract first number that looks like a price
    const match = finalText.match(/\b(\d[\d,]*\.?\d{0,2})\b/);
    if (!match) {
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'Could not parse price: ' + finalText.substring(0, 100) }) };
    }

    const price = parseFloat(match[1].replace(/,/g, ''));
    if (!price || price <= 0) {
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'Invalid price value: ' + match[1] }) };
    }

    console.log('Final price:', price, 'AUD');
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ median: price, count: 1 })
    };

  } catch(e) {
    console.error('Handler error:', e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
