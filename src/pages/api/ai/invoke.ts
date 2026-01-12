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

    // 🤖 Google Gemini Models (gemini-1.5-flash, gemini-1.5-pro, etc.)
    } else if (model.startsWith('gemini-') || model.includes('gemini')) {
      if (!import.meta.env.VITE_GOOGLE_API_KEY) {
        throw new Error('Google API key not configured. Please set VITE_GOOGLE_API_KEY in your .env file.');
      }

      // Map model names to Gemini API model IDs
      // Available models: gemini-2.5-flash, gemini-2.0-flash, gemini-flash-latest, gemini-2.5-pro, etc.
      let geminiModel = model;
      if (model === 'gemini-pro' || model === 'gemini-1.5-flash') {
        geminiModel = 'gemini-flash-latest'; // Legacy names - use latest flash
      } else if (model === 'gemini-1.5-pro') {
        geminiModel = 'gemini-pro-latest';
      } else if (model.startsWith('gemini-') || model.includes('gemini')) {
        geminiModel = model; // Keep as-is if already valid
      } else {
        geminiModel = 'gemini-flash-latest'; // Default to latest flash
      }

      const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${import.meta.env.VITE_GOOGLE_API_KEY}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: prompt }]
          }],
          generationConfig: {
            maxOutputTokens: 1000,
            temperature: 0.7
          }
        })
      });

      if (!geminiRes.ok) {
        const errorData = await geminiRes.json().catch(() => ({}));
        throw new Error(`Gemini error: ${errorData.error?.message || geminiRes.statusText}`);
      }

      const geminiData = await geminiRes.json();
      responseText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 'No response from Gemini';

    // 🤖 Add more providers here (Mistral, etc.)
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