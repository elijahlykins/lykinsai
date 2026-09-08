// Who decides the model on a coded-artifact turn.
//
// LYKN's Auto routing sends coded builds and edits to a dedicated coding
// model (CODED_ARTIFACT_MODEL — Grok 4.6 by default). Anything the USER chose
// must survive that reroute untouched, or every model picker in the product
// is lying about what it does.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CODED_ARTIFACT_MODEL,
  USER_CHOSEN_ROUTING_SOURCES,
  upgradeModelForCodedArtifact,
} from './modelInvoke.js';
import { ROUTING_SOURCES } from './chatRouting/chatRoutingConfig.js';
import { LYKN_CODING_MODEL_ID } from '../../src/lib/modelCatalog.js';

const PICKED = 'claude-opus-5';

/** upgradeModelForCodedArtifact reads XAI_API_KEY through the live env. */
function withXaiKey(fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'XAI_API_KEY');
  const prev = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = 'test-key';
  try {
    return fn();
  } finally {
    if (had) process.env.XAI_API_KEY = prev;
    else delete process.env.XAI_API_KEY;
  }
}

test('LYKN is the one place the default coding model is named', () => {
  // With no CODED_ARTIFACT_MODEL override in the environment, the server
  // default must come from the shared catalog constant the Build pill reads.
  if (!process.env.CODED_ARTIFACT_MODEL) {
    assert.equal(CODED_ARTIFACT_MODEL, LYKN_CODING_MODEL_ID);
  }
  assert.equal(LYKN_CODING_MODEL_ID, 'grok-4.6');
});

test('LYKN Auto sends coded turns to the dedicated coding model', () => {
  withXaiKey(() => {
    for (const source of [
      ROUTING_SOURCES.HEURISTIC,
      ROUTING_SOURCES.CLASSIFIER,
      ROUTING_SOURCES.FALLBACK,
    ]) {
      assert.equal(
        upgradeModelForCodedArtifact(PICKED, true, { routingSource: source }),
        CODED_ARTIFACT_MODEL,
        `${source} should take the coding route`,
      );
    }
  });
});

test('a model the user chose is never rerouted', () => {
  withXaiKey(() => {
    for (const source of [
      ROUTING_SOURCES.OVERRIDE,   // Build pill, chat-bar picker, bot's pinned model
      ROUTING_SOURCES.USER_SETUP, // My Setup category assignment
      ROUTING_SOURCES.ROUTE,      // named route on a bot
    ]) {
      assert.equal(
        upgradeModelForCodedArtifact(PICKED, true, { routingSource: source }),
        PICKED,
        `${source} is a user choice and must survive`,
      );
    }
    // A Model Builder persona owns its own base model.
    assert.equal(upgradeModelForCodedArtifact(PICKED, true, { customModel: { id: 'cm_1' } }), PICKED);
    assert.equal(upgradeModelForCodedArtifact(PICKED, true, { explicitPick: true }), PICKED);
  });
});

test('the reroute only touches coded turns', () => {
  withXaiKey(() => {
    assert.equal(
      upgradeModelForCodedArtifact(PICKED, false, { routingSource: ROUTING_SOURCES.HEURISTIC }),
      PICKED,
    );
  });
});

test('every user-chosen source is a real routing source', () => {
  // Drift guard: the set in modelInvoke.js is written as string literals to
  // keep that module free of routing imports at load time.
  const known = new Set(Object.values(ROUTING_SOURCES));
  for (const source of USER_CHOSEN_ROUTING_SOURCES) {
    assert.ok(known.has(source), `"${source}" is not in ROUTING_SOURCES`);
  }
  // And the ones deliberately left out are LYKN deciding, not the user.
  for (const source of [ROUTING_SOURCES.HEURISTIC, ROUTING_SOURCES.CLASSIFIER, ROUTING_SOURCES.FALLBACK]) {
    assert.ok(!USER_CHOSEN_ROUTING_SOURCES.has(source), `"${source}" is LYKN's own choice`);
  }
});

test('without an xAI key an Auto turn keeps its routed model', () => {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'XAI_API_KEY');
  const prev = process.env.XAI_API_KEY;
  delete process.env.XAI_API_KEY;
  try {
    // No dedicated coder configured — the turn must still build, not fail.
    assert.equal(
      upgradeModelForCodedArtifact(PICKED, true, { routingSource: ROUTING_SOURCES.HEURISTIC }),
      PICKED,
    );
  } finally {
    if (had) process.env.XAI_API_KEY = prev;
  }
});
