import { describe, expect, it } from 'vitest';
import { isWorkspaceLayout, workspaceTemplate, WORKSPACE_PRESETS } from './workspace-layout.js';
describe('workspace wire contract', () => {
  it('accepts each role template and multiple bounded pages', () => {
    for (const preset of WORKSPACE_PRESETS) expect(isWorkspaceLayout(workspaceTemplate(preset))).toBe(true);
    const layout = workspaceTemplate(); layout.pages.push(workspaceTemplate('frontdesk','desk','Ресепшен').pages[0]!);
    layout.startPageId = 'desk'; expect(isWorkspaceLayout(layout)).toBe(true);
  });
  it('rejects arbitrary execution, PII, unbounded pages and invalid references', () => {
    const changes = [(v: any) => { v.query = 'SELECT *'; }, (v: any) => { v.pages[0].widgets[0].settings.guestId = 'guest'; },
      (v: any) => { v.startPageId = 'missing'; }, (v: any) => { v.pages[0].widgets[0].width = 99; },
      (v: any) => { v.pages[0].widgets[0].settings.propertyId = 'https://attacker'; }, (v: any) => { v.pages[0].name = ''; },
      (v: any) => { v.pages = Array(9).fill(v.pages[0]); }, (v: any) => { v.pages[0].widgets.push(v.pages[0].widgets[0]); }];
    for (const change of changes) { const layout = workspaceTemplate(); change(layout); expect(isWorkspaceLayout(layout)).toBe(false); }
  });
});
