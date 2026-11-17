import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { SITE } from './src/config';

// SITE_URL / BASE_PATH are set by .github/workflows/pages.yml from the GitHub Pages
// settings (project page → "/REPO/", custom domain → "/"). Locally they fall back to config.ts.
const site = process.env.SITE_URL || SITE.siteUrl;
let base = process.env.BASE_PATH ?? SITE.basePath;
if (!base.startsWith('/')) base = '/' + base;
if (!base.endsWith('/')) base += '/';

export default defineConfig({
  site,
  base,
  trailingSlash: 'ignore',
  i18n: {
    defaultLocale: 'en',
    locales: ['en', 'zh-TW'],
    routing: { prefixDefaultLocale: false },
  },
  integrations: [
    sitemap({
      i18n: { defaultLocale: 'en', locales: { en: 'en', 'zh-TW': 'zh-TW' } },
    }),
  ],
  image: {
    // screenshots are local files, optimised at build time by sharp
    responsiveStyles: false,
  },
});
