const bootScript = `document.documentElement.dataset.theme = localStorage.getItem('theme') || 'light';`;

export function Head({ project }) {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: bootScript }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(caseSchema(project)) }} />
    </>
  );
}

const themeScript = ['(function(){', 'document.documentElement.dataset.mode = "auto";', '})();'].join('');

export function Theme() {
  return <script dangerouslySetInnerHTML={{ __html: themeScript }} />;
}
