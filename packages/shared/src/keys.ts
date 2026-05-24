import { Buffer } from 'node:buffer';

export type NamedKey =
  | 'enter'
  | 'tab'
  | 'esc'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'ctrl-c'
  | 'ctrl-d'
  | 'ctrl-l'
  | 'backspace'
  | 'delete'
  | 'home'
  | 'end'
  | 'pageup'
  | 'pagedown';

export type Key = NamedKey | { literal: string };

const NAMED: Record<NamedKey, string> = {
  enter: '\r',
  tab: '\t',
  esc: '\x1b',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  'ctrl-c': '\x03',
  'ctrl-d': '\x04',
  'ctrl-l': '\x0c',
  backspace: '\x7f',
  delete: '\x1b[3~',
  home: '\x1b[H',
  end: '\x1b[F',
  pageup: '\x1b[5~',
  pagedown: '\x1b[6~',
};

export function isNamedKey(s: string): s is NamedKey {
  return Object.prototype.hasOwnProperty.call(NAMED, s);
}

export function keyToBytes(k: Key): Buffer {
  if (typeof k === 'string') {
    if (!isNamedKey(k)) {
      throw new Error(`Unknown named key: ${k}`);
    }
    return Buffer.from(NAMED[k], 'utf8');
  }
  if (k && typeof k === 'object' && typeof k.literal === 'string') {
    return Buffer.from(k.literal, 'utf8');
  }
  throw new Error(`Invalid Key shape: ${JSON.stringify(k)}`);
}

export function keysToBytes(keys: Key[]): Buffer {
  return Buffer.concat(keys.map(keyToBytes));
}
