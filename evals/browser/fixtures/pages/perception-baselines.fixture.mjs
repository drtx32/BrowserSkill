import { escapeHtml, page } from "../../lib/fixtures.mjs";

const marker = (name) => `<p class="marker" data-baseline="${name}">${name}</p>`;

export default {
  id: "perception-baselines",
  routes: [
    "/perception/ordinary-form",
    "/perception/duplicate-controls",
    "/perception/modal",
    "/perception/iframe",
    "/perception/iframe-child",
    "/perception/stale-ref",
    "/perception/resume-sections",
  ],
  render({ pathname, runId }) {
    const send = (type, data = {}) => `browserEval.send(${JSON.stringify(type)}, ${JSON.stringify(data)})`;
    if (pathname === "/perception/ordinary-form") {
      return page({
        title: "Perception ordinary form",
        body: `<section class="card" data-fixture="ordinary-form"><h1>Profile</h1><form><label for="display-name">Display name</label><input id="display-name" name="displayName"><label for="timezone">Timezone</label><select id="timezone" name="timezone"><option>UTC</option><option>Asia/Taipei</option></select><button type="submit" id="save-profile">Save profile</button></form>${marker("PERCEPTION-ORDINARY-FORM")}</section>`,
      });
    }
    if (pathname === "/perception/duplicate-controls") {
      return page({
        title: "Perception duplicate controls",
        body: `<section class="card" data-fixture="duplicate-controls"><h1>Projects</h1><article><h2>Alpha</h2><button data-ambiguity="duplicate-name" aria-label="Edit Alpha">Edit</button></article><article><h2>Beta</h2><button data-ambiguity="duplicate-name" aria-label="Edit Beta">Edit</button></article>${marker("PERCEPTION-DUPLICATE-CONTROLS")}</section>`,
      });
    }
    if (pathname === "/perception/modal") {
      return page({
        title: "Perception modal",
        body: `<section class="card" data-fixture="modal"><h1>Settings</h1><button id="open-modal" aria-haspopup="dialog" onclick="${send("modal.opened")}">Open settings</button><div id="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" hidden><h2 id="dialog-title">Settings</h2><label for="modal-value">Value</label><input id="modal-value"><button id="modal-save" onclick="${send("modal.saved")}">Save</button><button id="modal-cancel" onclick="${send("modal.cancelled")}">Cancel</button></div>${marker("PERCEPTION-MODAL")}</section>`,
      });
    }
    if (pathname === "/perception/iframe") {
      return page({
        title: "Perception iframe",
        body: `<section class="card" data-fixture="iframe"><h1>Embedded checkout</h1><iframe title="Payment details" src="/perception/iframe-child?run=${encodeURIComponent(runId)}" width="600" height="160"></iframe>${marker("PERCEPTION-IFRAME")}</section>`,
      });
    }
    if (pathname === "/perception/iframe-child") {
      return page({
        title: "Perception iframe child",
        body: `<section class="card" data-fixture="iframe-child"><h2>Payment details</h2><label for="card-number">Card number</label><input id="card-number" autocomplete="cc-number"><button id="pay" aria-label="Pay securely">Pay</button>${marker("PERCEPTION-IFRAME-CHILD")}</section>`,
      });
    }
    if (pathname === "/perception/stale-ref") {
      return page({
        title: "Perception stale ref",
        body: `<section class="card" data-fixture="stale-ref"><h1>Rerendering editor</h1><div id="editor-region"><button id="save-draft" data-generation="1" onclick="${send("stale.before-rerender", { generation: 1 })};document.querySelector('#editor-region').innerHTML='<button id=\"save-draft\" data-generation=\"2\">Save draft</button>';${send("stale.after-rerender", { generation: 2 })}">Save draft</button></div>${marker("PERCEPTION-STALE-REF")}</section>`,
      });
    }
    return page({
      title: "Perception repeated sections",
      body: `<section class="card" data-fixture="resume-sections"><h1>Resume</h1><section aria-labelledby="experience-title"><h2 id="experience-title">Experience</h2><article data-section="experience"><label for="company-1" data-ambiguity="duplicate-name">Company</label><input id="company-1"><label for="role-1">Role</label><input id="role-1"></article><article data-section="experience"><label for="company-2" data-ambiguity="duplicate-name">Company</label><input id="company-2"><label for="role-2">Role</label><input id="role-2"></article><button id="add-experience" aria-label="Add experience section">Add experience</button></section>${marker("PERCEPTION-RESUME-SECTIONS")}</section>`,
    });
  },
};
