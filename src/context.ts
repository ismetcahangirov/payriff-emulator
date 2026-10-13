import type { Bank } from './bank.js';
import type { Callbacks } from './callbacks.js';
import type { Clock } from './clock.js';
import type { Config } from './config.js';
import type { State } from './state.js';

export interface Context {
  config: Config;
  clock: Clock;
  state: State;
  callbacks: Callbacks;
  bank: Bank;
}
