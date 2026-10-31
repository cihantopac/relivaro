const schema = { '@context': 'https://schema.org', '@type': 'Organization', name: 'Acme' };

export function Bio({ bio }: { bio: string }) {
  return (
    <section>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }} />
      <div dangerouslySetInnerHTML={{ __html: bio }} /> {/* expect: sec/xss */}
    </section>
  );
}
