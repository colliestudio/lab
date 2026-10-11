import type { ComponentType, Values } from './model';

// Built-in starter types. Plain data: exactly what a user, a peer or an agent could write by hand.

export const STARTER_TYPES: ComponentType[] = [
  {
    id: 'persona',
    name: 'Persona',
    icon: '🧑',
    color: '#7b5ea7',
    title: 'name',
    fields: [
      { id: 'name', label: 'Name', kind: 'text' },
      { id: 'avatar', label: 'Avatar', kind: 'image' },
      { id: 'role', label: 'Role', kind: 'text', card: true },
      { id: 'goals', label: 'Goals', kind: 'list', card: true },
      { id: 'pains', label: 'Pains', kind: 'list' },
      { id: 'quote', label: 'Quote', kind: 'longtext' },
    ],
  },
  {
    id: 'story',
    name: 'User story',
    icon: '📗',
    color: '#2f7d5b',
    title: 'want',
    fields: [
      { id: 'want', label: 'I want', kind: 'text' },
      { id: 'as', label: 'As a', kind: 'ref', to: 'persona', card: true },
      { id: 'so', label: 'So that', kind: 'longtext' },
      { id: 'status', label: 'Status', kind: 'enum', options: ['Idea', 'Ready', 'Doing', 'Done'], card: true },
      { id: 'points', label: 'Points', kind: 'number' },
    ],
  },
  {
    id: 'adr',
    name: 'Decision',
    icon: '⚖️',
    color: '#a5632a',
    title: 'title',
    fields: [
      { id: 'title', label: 'Title', kind: 'text' },
      { id: 'status', label: 'Status', kind: 'enum', options: ['Proposed', 'Accepted', 'Superseded', 'Rejected'], card: true },
      { id: 'context', label: 'Context', kind: 'longtext' },
      { id: 'decision', label: 'Decision', kind: 'longtext', card: true },
      { id: 'consequences', label: 'Consequences', kind: 'list' },
    ],
  },
  {
    id: 'metric',
    name: 'Metric',
    icon: '📈',
    color: '#2a6aa5',
    title: 'name',
    fields: [
      { id: 'name', label: 'Name', kind: 'text' },
      { id: 'current', label: 'Current', kind: 'number', card: true },
      { id: 'target', label: 'Target', kind: 'number', card: true },
      { id: 'unit', label: 'Unit', kind: 'text' },
      { id: 'serves', label: 'Serves', kind: 'ref', to: 'story' },
    ],
  },
];

/** Sample instances for the starter kit: [type, local key, values, dx, dy]. Ref values name local keys. */
export const STARTER_SAMPLES: [string, string, Values, number, number][] = [
  ['persona', 'p1', { name: 'Hana, the host', avatar: 'https://api.dicebear.com/9.x/notionists/svg?seed=Hana', role: 'Runs game night', goals: ['Set up a table in a minute', 'Nobody needs an account'], pains: ['Rules disputes', 'Lost pieces'], quote: 'If it takes longer than shuffling, I won’t use it.' }, 0, 0],
  ['persona', 'p2', { name: 'Dev, the facilitator', avatar: 'https://api.dicebear.com/9.x/notionists/svg?seed=Dev', role: 'Runs event storming', goals: ['Capture the session as data', 'Hand results to an agent'], pains: ['Photos of sticky notes'], quote: 'The wall should be the spec.' }, 0, 460],
  ['story', 's1', { as: 'p1', want: 'Share a table by link', so: 'friends can join without installing anything', status: 'Done', points: 3 }, 380, 0],
  ['story', 's2', { as: 'p2', want: 'Define my own sticky types', so: 'the board matches our method', status: 'Doing', points: 5 }, 380, 260],
  ['story', 's3', { as: 'p2', want: 'Export the board as Markdown', so: 'an agent can turn it into tickets', status: 'Ready', points: 2 }, 380, 520],
  ['adr', 'a1', { title: 'Component types are data, not code', status: 'Accepted', context: 'Users want custom card types; code plugins are risky to share.', decision: 'Types live in the canvas file as JSON schemas with a declarative look.', consequences: ['Safe to share', 'No custom behavior', 'Agents can author types'] }, 760, 0],
  ['metric', 'm1', { name: 'Time to first table', current: 75, target: 30, unit: 'seconds', serves: 's1' }, 760, 380],
];
