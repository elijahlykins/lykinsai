// GET /api/ai/models — extracted from server.js.
import { MODEL_CATALOG, getDynamicOpenAIGptModels } from './modelInvoke.js';

export function registerAiModelsRoute(app) {
  app.get('/api/ai/models', (req, res) => {
    getDynamicOpenAIGptModels().then((openaiGptModels) => {
      const staticIds = new Set(MODEL_CATALOG.map((m) => m.id));
      const dynamicOpenAI = openaiGptModels
        .filter((id) => !staticIds.has(id))
        .map((id) => ({
          id,
          label: id.toUpperCase(),
          provider: 'openai',
          env: 'OPENAI_API_KEY',
        }));

      const mergedCatalog = [...MODEL_CATALOG, ...dynamicOpenAI];
      const models = mergedCatalog.map((m) => {
        const enabled = !m.env || Boolean(process.env[m.env]);
        return {
          id: m.id,
          label: m.label,
          provider: m.provider,
          enabled,
        };
      });
      res.json({ models });
    }).catch((error) => {
      console.error('❌ Model discovery failed:', error?.message || error);
      const models = MODEL_CATALOG.map((m) => ({
        id: m.id,
        label: m.label,
        provider: m.provider,
        enabled: !m.env || Boolean(process.env[m.env]),
      }));
      res.json({ models });
    });
  });
}
