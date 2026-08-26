-- Retire database runtime hooks owned exclusively by the removed Synthesis UI
-- and legacy personal-memory write paths.
--
-- This migration does not delete user data or legacy tables.
-- The legacy fact table remains readable by the narrow Markdown Memory
-- compatibility importer until migration completion is measured.

DROP TRIGGER IF EXISTS trg_omnia_boards_synthesis_cap
  ON public.omnia_boards;
DROP TRIGGER IF EXISTS trg_lykn_beliefs_synthesis_cap
  ON public.lykn_beliefs;
DROP TRIGGER IF EXISTS trg_lykn_user_model_facts_synthesis_cap
  ON public.lykn_user_model_facts;

DROP FUNCTION IF EXISTS public.enforce_synthesis_neuron_cap_boards();
DROP FUNCTION IF EXISTS public.enforce_synthesis_neuron_cap_beliefs();
DROP FUNCTION IF EXISTS public.enforce_synthesis_neuron_cap_facts();
DROP FUNCTION IF EXISTS public.count_user_explicit_neurons(uuid);
DROP FUNCTION IF EXISTS public.synthesis_neuron_cap_for_plan(text);
