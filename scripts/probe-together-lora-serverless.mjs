#!/usr/bin/env node
/**
 * Probe Together serverless Multi-LoRA (host model + lora adapter field).
 * Usage: node scripts/probe-together-lora-serverless.mjs <adapterId> [baseTogetherModel]
 */
import 'dotenv/config';
import { pickWorkingServerlessLoraPair } from '../lib/lora/togetherServerlessLora.js';

const adapterId = process.argv[2];
const base = process.argv[3] || 'Qwen/Qwen3-8B';
if (!adapterId) {
  console.error('Usage: node scripts/probe-together-lora-serverless.mjs <adapterId> [baseTogetherModel]');
  process.exit(1);
}
if (!process.env.TOGETHER_API_KEY) {
  console.error('Set TOGETHER_API_KEY');
  process.exit(1);
}

const picked = await pickWorkingServerlessLoraPair(adapterId, base);
console.log('Result:', picked);
process.exit(picked.probed ? 0 : 1);
