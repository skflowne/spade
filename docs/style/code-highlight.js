(() => {
  if (!window.hljs) {
    return
  }

  const languageAliases = new Map([['ts', 'typescript']])

  for (const code of document.querySelectorAll('pre > code[class*="language-"]')) {
    const language = [...code.classList]
      .find((className) => className.startsWith('language-'))
      ?.slice('language-'.length)

    if (!language || language === 'text') {
      continue
    }

    const normalizedLanguage = languageAliases.get(language) ?? language
    if (!window.hljs.getLanguage(normalizedLanguage)) {
      continue
    }

    code.classList.replace(`language-${language}`, `language-${normalizedLanguage}`)
    window.hljs.highlightElement(code)
  }
})()
