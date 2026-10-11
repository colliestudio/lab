import type { App } from '../../core';
import { kindOf, nameOf } from './commands';
import { VERBS, VERB_IDS, describeStep, parseTarget, targetText, validateSteps, validateTrigger, type ArgSpec, type ButtonField, type Cond, type Step, type Target, type Trigger, type Verb } from './model';

// The step editor: a list of rows (verb + its fields, "only if", ↑ ↓ ✕), a trigger, and the same
// thing as JSON (what's stored in the node, what an agent writes). Saving goes through `auto.edit`,
// which validates again: the editor is a convenience, the schema is the gate.

export interface EditResult {
  draft: ButtonField;
  run: boolean;
}

type Draft = { name: string; steps: Record<string, unknown>[]; trigger?: Trigger };

let open: HTMLElement | null = null;

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** Names on the table worth offering as targets (plus the kind words). */
function suggestions(app: App): string[] {
  const out = new Set<string>(['hands', 'clock', 'cards in Pile']);
  for (const n of app.doc.nodes) {
    const k = kindOf(n);
    if (!k || k === 'card' || k === 'button') continue;
    const name = nameOf(n);
    if (!name || name.length > 40) continue;
    out.add(name);
    if (k === 'deck' || k === 'zone' || k === 'mat') out.add(`cards in ${name}`);
    if (k === 'zone' || k === 'mat') out.add(`notes in ${name}`);
  }
  return [...out];
}

/** Stored steps may come from a peer or a file: a non-object entry becomes an unknown-verb row (shown as an error, removable). */
const asSteps = (v: unknown[]): Record<string, unknown>[] => v.map((x) => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : { do: x }));

function blankStep(verb: Verb): Record<string, unknown> {
  const s: Record<string, unknown> = { do: verb };
  for (const [k, spec] of Object.entries(VERBS[verb].args)) {
    if (spec.optional) continue;
    s[k] = spec.type === 'count' ? 1 : spec.type === 'bool' ? false : spec.type === 'clockAction' ? 'start' : spec.type === 'list' ? ['A', 'B'] : spec.type === 'target' ? undefined : '';
  }
  return s;
}

export function editButton(app: App, start: ButtonField): Promise<EditResult | null> {
  open?.remove();
  const draft: Draft = structuredClone({ name: start.name, steps: asSteps(start.steps), trigger: start.trigger });
  const listId = `au-targets-${Math.random().toString(36).slice(2)}`;

  return new Promise((resolve) => {
    const overlay = h('div', 'name-overlay au-overlay');
    const panel = h('div', 'au-editor');
    panel.setAttribute('role', 'dialog');
    overlay.append(panel);

    const datalist = h('datalist');
    datalist.id = listId;
    for (const s of suggestions(app)) {
      const o = h('option');
      o.value = s;
      datalist.append(o);
    }

    // header: name + trigger
    const head = h('div', 'au-head');
    const name = h('input', 'au-name');
    name.value = draft.name;
    name.maxLength = 60;
    name.placeholder = 'Button name';
    name.addEventListener('input', () => {
      draft.name = name.value;
      check();
    });
    const trig = h('select', 'au-trigger');
    for (const [v, label] of [
      ['click', 'Runs on click'],
      ['enter', 'Also runs when a card enters…'],
    ]) {
      const o = h('option', undefined, label);
      o.value = v;
      trig.append(o);
    }
    const trigZone = targetInput(draft.trigger?.on === 'enter' ? draft.trigger.zone : undefined, (t) => {
      draft.trigger = t ? { on: 'enter', zone: t } : ({ on: 'enter' } as unknown as Trigger);
      check();
    });
    trig.value = draft.trigger?.on ?? 'click';
    const syncTrig = () => {
      trigZone.hidden = trig.value !== 'enter';
      if (trig.value === 'click') draft.trigger = undefined;
      else draft.trigger = { on: 'enter', zone: parseTarget(trigZone.value) ?? ({} as Target) };
      check();
    };
    trig.addEventListener('change', syncTrig);
    head.append(name, trig, trigZone);

    // tabs
    const tabs = h('div', 'au-tabs');
    const tabSteps = h('button', 'au-tab on', 'Steps');
    const tabJson = h('button', 'au-tab', 'JSON (what is stored; agents write this)');
    tabs.append(tabSteps, tabJson);
    const list = h('ol', 'au-steps');
    const add = h('div', 'au-add');
    const addSel = h('select');
    addSel.append(Object.assign(h('option', undefined, '+ Add a step…'), { value: '' }));
    for (const v of VERB_IDS) addSel.append(Object.assign(h('option', undefined, `${VERBS[v].label} — ${VERBS[v].hint}`), { value: v }));
    addSel.addEventListener('change', () => {
      if (!addSel.value) return;
      draft.steps.push(blankStep(addSel.value as Verb));
      addSel.value = '';
      renderSteps();
    });
    add.append(addSel);
    const json = h('textarea', 'au-json');
    json.spellcheck = false;
    json.hidden = true;
    const errors = h('ul', 'au-errors');

    const actions = h('div', 'au-actions');
    const cancel = h('button', 'au-btn', 'Cancel');
    const save = h('button', 'au-btn au-primary', 'Save');
    const saveRun = h('button', 'au-btn au-primary', 'Save & run');
    actions.append(cancel, save, saveRun);
    panel.append(h('h2', undefined, 'Edit button'), head, tabs, list, add, json, errors, actions, datalist);

    function targetInput(t: Target | undefined, set: (t: Target | null) => void) {
      const i = h('input', 'au-target');
      i.setAttribute('list', listId);
      i.placeholder = 'Main, hands, cards in Pile…';
      i.value = t ? targetText(t) : '';
      i.addEventListener('input', () => set(parseTarget(i.value)));
      return i;
    }

    function field(step: Record<string, unknown>, key: string, spec: ArgSpec): HTMLElement {
      const wrap = h('label', 'au-field');
      wrap.append(h('span', undefined, spec.label));
      const v = step[key];
      const update = (val: unknown) => {
        if (val === undefined || val === '') delete step[key];
        else step[key] = val;
        check();
      };
      let input: HTMLElement;
      switch (spec.type) {
        case 'target':
          input = targetInput(v as Target | undefined, (t) => update(t ?? undefined));
          break;
        case 'count':
        case 'number': {
          const i = h('input', 'au-num');
          i.value = v === undefined ? '' : String(v);
          i.placeholder = spec.type === 'count' ? '13 or even' : spec.optional ? 'all' : '';
          i.addEventListener('input', () => update(i.value.trim() === 'even' && spec.type === 'count' ? 'even' : i.value.trim() === '' ? undefined : Number(i.value)));
          input = i;
          break;
        }
        case 'bool': {
          const i = h('input');
          i.type = 'checkbox';
          i.checked = v === true;
          i.addEventListener('change', () => update(i.checked));
          input = i;
          break;
        }
        case 'text': {
          const i = h('input', 'au-text');
          i.value = typeof v === 'string' ? v : '';
          i.addEventListener('input', () => update(i.value));
          input = i;
          break;
        }
        case 'list': {
          const i = h('input', 'au-text');
          i.value = Array.isArray(v) ? v.join(', ') : '';
          i.placeholder = 'One, Two, Three';
          i.addEventListener('input', () =>
            update(
              i.value
                .split(',')
                .map((x) => x.trim())
                .filter(Boolean),
            ),
          );
          input = i;
          break;
        }
        case 'clockAction': {
          const sel = h('select');
          for (const a of ['start', 'pause', 'reset']) sel.append(Object.assign(h('option', undefined, a), { value: a }));
          sel.value = typeof v === 'string' ? v : 'start';
          sel.addEventListener('change', () => update(sel.value));
          input = sel;
          break;
        }
      }
      wrap.append(input);
      return wrap;
    }

    function whenRow(step: Record<string, unknown>): HTMLElement {
      const row = h('div', 'au-when');
      const c = step.when as Cond | undefined;
      const mode = h('select');
      for (const [v, label] of [
        ['', 'always'],
        ['empty', 'only if … is empty'],
        ['not-empty', 'only if … is not empty'],
      ])
        mode.append(Object.assign(h('option', undefined, label), { value: v }));
      mode.value = c?.is ?? '';
      const target = targetInput(c?.target, (t) => {
        if (step.when) (step.when as Cond).target = t ?? ({} as Target);
        check();
      });
      const match = h('select');
      for (const [v, label] of [
        ['all', 'all of them'],
        ['any', 'any of them'],
      ])
        match.append(Object.assign(h('option', undefined, label), { value: v }));
      match.value = c?.match ?? 'all';
      const sync = () => {
        target.hidden = match.hidden = !mode.value;
        if (!mode.value) delete step.when;
        else {
          const w: Cond = { target: parseTarget(target.value) ?? ({} as Target), is: mode.value as Cond['is'] };
          if (match.value === 'any') w.match = 'any';
          step.when = w;
        }
        check();
      };
      mode.addEventListener('change', sync);
      match.addEventListener('change', sync);
      target.addEventListener('input', sync);
      target.hidden = match.hidden = !mode.value;
      row.append(mode, target, match);
      return row;
    }

    function renderSteps() {
      list.replaceChildren();
      draft.steps.forEach((step, i) => {
        const li = h('li', 'au-step');
        const top = h('div', 'au-row');
        const verb = h('select', 'au-verb');
        for (const v of VERB_IDS) verb.append(Object.assign(h('option', undefined, VERBS[v].label), { value: v }));
        verb.value = String(step.do);
        verb.addEventListener('change', () => {
          const next = blankStep(verb.value as Verb);
          // keep fields the new verb shares (a target stays a target)
          for (const k of Object.keys(VERBS[verb.value as Verb].args)) if (step[k] !== undefined) next[k] = step[k];
          if (step.when) next.when = step.when;
          draft.steps[i] = next;
          renderSteps();
        });
        top.append(verb);
        const spec = typeof step.do === 'string' && Object.hasOwn(VERBS, step.do) ? VERBS[step.do as Verb] : undefined;
        if (spec) for (const [k, a] of Object.entries(spec.args)) top.append(field(step, k, a));
        const tools = h('span', 'au-tools');
        const mv = (d: number) => () => {
          const j = i + d;
          if (j < 0 || j >= draft.steps.length) return;
          [draft.steps[i], draft.steps[j]] = [draft.steps[j], draft.steps[i]];
          renderSteps();
        };
        const up = h('button', 'au-icon', '↑');
        up.title = 'Move up';
        up.disabled = i === 0;
        up.addEventListener('click', mv(-1));
        const down = h('button', 'au-icon', '↓');
        down.title = 'Move down';
        down.disabled = i === draft.steps.length - 1;
        down.addEventListener('click', mv(1));
        const del = h('button', 'au-icon', '✕');
        del.title = 'Remove';
        del.addEventListener('click', () => {
          draft.steps.splice(i, 1);
          renderSteps();
        });
        tools.append(up, down, del);
        top.append(tools);
        li.append(top, whenRow(step), h('div', 'au-desc'));
        list.append(li);
      });
      check();
    }

    function errorsNow(): string[] {
      const e = [...validateSteps(draft.steps), ...validateTrigger(draft.trigger)];
      if (!draft.name.trim()) e.unshift('the button needs a name');
      return e;
    }

    function check() {
      const errs = errorsNow();
      errors.replaceChildren(...errs.map((e) => h('li', undefined, e)));
      save.disabled = saveRun.disabled = errs.length > 0;
      // the plain-language line under each row
      [...list.children].forEach((li, i) => {
        const d = li.querySelector('.au-desc');
        const ok = !validateSteps([draft.steps[i]]).length;
        if (d) d.textContent = ok ? describeStep(draft.steps[i] as unknown as Step) : '…';
      });
    }

    const showJson = (on: boolean) => {
      if (on) json.value = JSON.stringify({ name: draft.name, ...(draft.trigger ? { trigger: draft.trigger } : {}), steps: draft.steps }, null, 2);
      else {
        try {
          const v = JSON.parse(json.value) as Draft;
          draft.name = typeof v.name === 'string' ? v.name : draft.name;
          draft.steps = Array.isArray(v.steps) ? asSteps(v.steps) : draft.steps;
          draft.trigger = v.trigger;
          name.value = draft.name;
          trig.value = draft.trigger?.on ?? 'click';
          trigZone.value = draft.trigger?.on === 'enter' ? targetText(draft.trigger.zone) : '';
          trigZone.hidden = trig.value !== 'enter';
        } catch {
          errors.replaceChildren(h('li', undefined, 'JSON does not parse: fix it or switch back to undo'));
          return false;
        }
      }
      json.hidden = !on;
      list.hidden = add.hidden = on;
      tabJson.classList.toggle('on', on);
      tabSteps.classList.toggle('on', !on);
      if (!on) renderSteps();
      return true;
    };
    tabSteps.addEventListener('click', () => !json.hidden && showJson(false));
    tabJson.addEventListener('click', () => json.hidden && showJson(true));
    json.addEventListener('input', () => {
      try {
        const v = JSON.parse(json.value) as Draft;
        const e = [...validateSteps(v.steps), ...validateTrigger(v.trigger)];
        errors.replaceChildren(...e.map((x) => h('li', undefined, x)));
        save.disabled = saveRun.disabled = e.length > 0;
      } catch (err) {
        errors.replaceChildren(h('li', undefined, `JSON: ${(err as Error).message}`));
        save.disabled = saveRun.disabled = true;
      }
    });

    const done = (r: EditResult | null) => {
      window.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (open === overlay) open = null;
      resolve(r);
    };
    const finish = (run: boolean) => {
      if (!json.hidden && !showJson(false)) return;
      if (errorsNow().length) return check();
      done({ draft: { name: draft.name.trim(), steps: draft.steps as unknown as Step[], trigger: draft.trigger }, run });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        done(null);
      } else if (!(e.target instanceof Node && overlay.contains(e.target))) e.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKey, true);
    // keys typed in the editor never reach the table's shortcuts
    panel.addEventListener('keydown', (e) => e.stopPropagation());
    cancel.addEventListener('click', () => done(null));
    save.addEventListener('click', () => finish(false));
    saveRun.addEventListener('click', () => finish(true));
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) done(null);
    });
    document.body.append(overlay);
    open = overlay;
    trigZone.hidden = trig.value !== 'enter';
    renderSteps();
    name.focus();
  });
}
