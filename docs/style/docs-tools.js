(() => {
  if (window.top !== window.self) {
    return
  }

  const page = window.location.pathname.replace(/^\/+/, '')
  if (!page.startsWith('docs/')) {
    return
  }

  const button = document.createElement('a')
  button.className = 'docs-compare-button'
  button.href = `/__compare?page=${encodeURIComponent(page)}`
  button.textContent = 'Compare with base'
  document.body.append(button)
})()
