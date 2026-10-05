import { v7 } from 'uuid';

export const now = () => new Date().toISOString();
export const newId = () => v7();
