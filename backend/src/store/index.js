import path from 'node:path';
import { JsonStore } from './jsonStore.js';

export async function createStore(filePath = path.resolve('data/store.json')) { return new JsonStore(filePath).init(); }
