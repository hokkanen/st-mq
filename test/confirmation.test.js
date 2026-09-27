import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmAction } from '../chart/confirmation.js';

test('confirmation fails closed when app dialogs are unavailable without opening a browser dialog', async () => {
  let browserCalls = 0;
  for (const document of [undefined, {}, { defaultView: { confirm() { browserCalls++; return true; } } }]) {
    assert.equal(await confirmAction({ document, title: 'Change setting?', message: 'Apply this change.' }), false);
  }
  assert.equal(browserCalls, 0);
});

test('app confirmation focuses Cancel, prevents concurrent dialogs and restores focus after either choice', async () => {
  const document = { defaultView: { HTMLDialogElement: class {} },
    createElement(tagName) {
      const node = Object.assign(new EventTarget(), {
        tagName, children: [], attributes: new Map(),
        setAttribute(name, value) { this.attributes.set(name, value); },
        append(...children) { this.children.push(...children); },
        focus() { document.activeElement = this; },
        remove() { document.body.children.splice(document.body.children.indexOf(this), 1); },
        showModal() { this.open = true; },
        close(value) { this.open = false; this.returnValue = value; this.dispatchEvent(new Event('close')); },
      });
      return node;
    } };
  document.body = document.createElement('body');
  const trigger = document.createElement('button'); trigger.focus();
  const options = { document, title: 'Change setting?', message: 'Apply this change.', action: 'Change setting' };
  for (const accepted of [false, true]) {
    const pending = confirmAction(options), dialog = document.body.children[0];
    assert.equal(dialog.tagName, 'dialog'); assert.equal(dialog.open, true);
    assert.equal(dialog.className, 'confirmation-dialog');
    const [heading, description, actions] = dialog.children, [cancel, apply] = actions.children;
    assert.equal(heading.textContent, options.title); assert.equal(description.textContent, options.message);
    assert.equal(document.activeElement, cancel);
    assert.equal(await confirmAction(options), false);
    assert.equal(document.body.children.length, 1);
    (accepted ? apply : cancel).dispatchEvent(new Event('click'));
    assert.equal(await pending, accepted);
    assert.equal(document.body.children.length, 0);
    assert.equal(document.activeElement, trigger);
  }
});
