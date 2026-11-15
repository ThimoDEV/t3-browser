// Tiny local site used by the end-to-end test.
import { createServer } from "node:http";

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px system-ui;margin:40px} .modal{position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center}
.modal div{background:#fff;padding:20px} #spacer{height:2400px}</style></head><body>${body}</body></html>`;

const pages = {
  "/form.html": page(
    "Signup form",
    `<h1>Signup</h1>
     <form id="f" onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'Hello ' + this.name.value + ' from ' + this.country.value + (this.terms.checked ? ' (agreed)' : '');">
       <label>Name <input name="name" placeholder="Your name"></label>
       <label>Country <select name="country"><option value="nl">Netherlands</option><option value="be">Belgium</option></select></label>
       <label><input type="checkbox" name="terms"> I agree</label>
       <button type="submit">Send</button>
     </form>
     <p id="out"></p>
     <button onclick="alert('Are you there?')">Show alert</button>
     <button onclick="setTimeout(() => { const p = document.createElement('p'); p.textContent = 'Loaded later'; document.body.append(p); }, 600)">Load later</button>
     <a href="/page2.html">Go to page two</a>
     <a href="/page2.html" target="_blank">Open page two in a new tab</a>
     <iframe src="/frame.html" title="Inner frame" width="300" height="80"></iframe>
     <div id="spacer"></div>
     <button onclick="this.textContent='Bottom clicked'">Bottom button</button>`,
  ),
  "/covered.html": page(
    "Covered",
    `<button onclick="document.title='clicked'">Hidden behind modal</button>
     <div class="modal"><div>Cookie banner <button onclick="this.closest('.modal').remove()">Accept cookies</button></div></div>`,
  ),
  "/page2.html": page("Page two", `<h1>Second page</h1><p>You made it.</p>`),
  "/upload.html": page(
    "Upload",
    `<label>Attachment <input type="file" id="file"></label><p id="out"></p>
     <script>
       document.getElementById("file").onchange = async (e) => {
         const f = e.target.files[0];
         document.getElementById("out").textContent = f.name + ": " + (await f.text());
       };
     </script>`,
  ),
  "/frame.html": page("Frame", `<button onclick="this.textContent='Frame clicked'">Inside frame</button>`),
};

export function startFixtures() {
  const server = createServer((req, res) => {
    const body = pages[new URL(req.url, "http://x").pathname];
    if (!body) {
      res.writeHead(404);
      return res.end("not found");
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}
