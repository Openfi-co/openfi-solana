import { describeConformance } from '@openfi/chain-conformance';
import { createLiteSvmHarness } from './harness.js';

// The shared OpenFi rules, run against the real programs on LiteSVM.
describeConformance('solana (LiteSVM)', createLiteSvmHarness);
