import { MemSource } from './source';
import { sourceContract } from './source.contract';

sourceContract('MemSource', async () => {
  const source = new MemSource(MemSource.info(), [
    MemSource.card('TASK-1', { title: 'First', labels: ['x'], sections: { description: 'about first' }, checklist: [{ text: 'one', done: false }, { text: 'two', done: false }] }),
    MemSource.card('TASK-2', { title: 'Second' }),
  ]);
  return { source, ids: { a: 'TASK-1', b: 'TASK-2' }, outsideEdit: async (id) => source.outside(id, { title: `edited ${Math.random()}` }), cleanup: () => {} };
});
