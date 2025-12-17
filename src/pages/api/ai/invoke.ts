// src/pages/api/ai/invoke.ts
import type { APIRoute } from 'astro'; // Vite-compatible API route type

// ✅ Handle POST requests to /api/ai/invoke
export const POST: APIRoute = async ({ request }) => {
  try {
    const { model, prompt } = await request.json();

    // Validate input
    if (!model || !prompt) {
      return new Response(
        JSON.stringify({ error: 'Missing model or prompt' }),
        { 
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }

    let responseText = '';

    // 🔑 OpenAI Models (gpt-3.5-turbo, gpt-4, gpt-4o, etc.)
    if (model.startsWith('gpt-')) {
      const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${import.meta.env.VITE_OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 1000,
          temperature: 0.7
        })
      });

      if (!openaiRes.ok) {
        const errorData = await openaiRes.json();
        throw new Error(`OpenAI error: ${errorData.error?.message || openaiRes.statusText}`);
      }

      const openaiData = await openaiRes.json();
      responseText = openaiData.choices?.[0]?.message?.content || 'No response from OpenAI';

    // 🧠 Anthropic Models (claude-3-5-sonnet, claude-3-opus, etc.)
    } else if (model.includes('claude')) {
      const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': import.meta.env.VITE_ANTHROPIC_API_KEY!,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 1000,
          temperature: 0.7
        })
      });

      if (!anthropicRes.ok) {
        const errorData = await anthropicRes.json();
        throw new Error(`Anthropic error: ${errorData.error?.message || anthropicRes.statusText}`);
      }

      const anthropicData = await anthropicRes.json();
      responseText = anthropicData.content?.[0]?.text || 'No response from Anthropic';

    // 🤖 Add more providers here (Mistral, Google Gemini, etc.)
    } else {
      return new Response(
        JSON.stringify({ error: `Unsupported model: ${model}` }),
        { 
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }

    // ✅ Success response
    return new Response(
      JSON.stringify({ response: responseText }),
      { 
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }
    );

  } catch (error: any) {
    console.error('AI API error:', error);
    
    // ❌ Error response
    return new Response(
      JSON.stringify({ 
        error: error.message || 'Failed to process AI request',
        details: error.toString()
      }),
      { 
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
};