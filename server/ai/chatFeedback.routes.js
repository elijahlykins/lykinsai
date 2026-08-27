// POST /api/ai/feedback — thumbs up/down on assistant replies.
export function registerAiFeedbackRoute(app, { requireAuth, supabaseAdmin }) {
  // Persist a chat thumbs up/down on an assistant reply. `rating: null` clears
  // it (deletes the row); 'like'/'dislike' upserts on (user_id, message_id).
  app.post('/api/ai/feedback', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });

      const messageId = String(req.body?.messageId || '').trim().slice(0, 200);
      if (!messageId) return res.status(400).json({ error: 'message_id_required' });

      const rawRating = req.body?.rating;
      const rating = rawRating === 'like' || rawRating === 'dislike' ? rawRating : null;

      if (rating === null) {
        const { error } = await supabaseAdmin
          .from('message_feedback')
          .delete()
          .eq('user_id', userId)
          .eq('message_id', messageId);
        if (error) throw error;
        return res.json({ ok: true, rating: null });
      }

      const chatId = req.body?.chatId ? String(req.body.chatId).slice(0, 200) : null;
      const model = req.body?.model ? String(req.body.model).slice(0, 120) : null;
      const prompt = req.body?.prompt ? String(req.body.prompt).slice(0, 8000) : null;
      const response = req.body?.response ? String(req.body.response).slice(0, 20000) : null;

      const { error } = await supabaseAdmin
        .from('message_feedback')
        .upsert(
          {
            user_id: userId,
            message_id: messageId,
            chat_id: chatId,
            rating,
            model,
            prompt,
            response,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'user_id,message_id' },
        );
      if (error) throw error;
      return res.json({ ok: true, rating });
    } catch (e) {
      console.error('❌ /api/ai/feedback:', e?.message || e);
      return res.status(500).json({ error: 'feedback_failed' });
    }
  });
}
