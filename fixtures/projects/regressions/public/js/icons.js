function icon(name) {
  var holder = document.createElement('span');
  // Regression: the interpolated value is allowlist-filtered before it reaches innerHTML.
  holder.innerHTML = '<svg class="ico"><use href="#i-' + String(name).replace(/[^a-z-]/g, '') + '"></use></svg>';
  return holder.firstChild;
}
