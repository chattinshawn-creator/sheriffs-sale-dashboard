export function renderNav(el) {
  el.innerHTML = `
    <nav class="top-nav">
      <span class="brand">Sheriff's Sale Dashboard</span>
      <a href="#/">Home</a>
      <a href="#/map">Map</a>
      <a href="#/upload">Upload</a>
      <a href="#/settings">Settings</a>
    </nav>
  `
}
