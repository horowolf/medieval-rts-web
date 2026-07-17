// Hides the development tooling in public builds.
//
// The debug overlay (coordinate readout, path rendering, movement log) and the
// arena test-battle harness exist for development and for the headless
// regression suite, which drives them through window.dbg. Deleting them would
// take the test suite with them, so the public build only hides their entry
// points from the UI -- the buttons stay in the DOM and keep working when
// clicked programmatically. Append ?dev=1 to the URL to get them back on screen.

const REQUIRED_ANCHORS = ['#dbgBtn', '#arenaBtn'];

const SNIPPET = `
/* Public build: development entry points are hidden unless ?dev=1 is set.
   They are hidden rather than removed, so window.dbg, the arena harness and the
   headless regression suite all keep working against this exact file. */
(function hideDevTools(){
  try{ if(new URLSearchParams(location.search).get('dev')==='1')return; }catch(e){}
  for(const id of ['dbgBtn','arenaBtn']){const el=document.getElementById(id);if(el)el.style.display='none';}
})();
`;

export function applyDevGating(js) {
  for (const anchor of REQUIRED_ANCHORS) {
    if (!js.includes(anchor)) {
      throw new Error(`dev-tool gating anchor ${anchor} is gone -- check tools/lib/devtools.mjs against the source`);
    }
  }
  return `${js}\n${SNIPPET}`;
}
