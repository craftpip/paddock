import { defineConfig } from 'vitepress'

// Base is repo-aware for GitHub Pages: set DOCS_BASE=/<repo>/ or DOCS_BASE=/<repo>/docs/
// Local dev via Express at /website/
const base = process.env.DOCS_BASE || '/website/'

export default defineConfig({
  title: 'Paddock',
  description: 'Run AI agents like cattle. One panel. Docker control plane for PADs — openclaw, opencode, picoclaw, hermes, codex, claude.',
  base,
  lang: 'en-US',
  cleanUrls: true,
  lastUpdated: true,
  appearance: 'dark',
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base.replace(/\/$/, '')}/paddock-logo.svg` }],
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
  ],

  themeConfig: {
    logo: '/paddock-logo.svg',
    siteTitle: 'Paddock',

    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Docs', link: '/README' },
      { text: 'GitHub', link: 'https://github.com/craftpip/vm-friends' },
    ],

    sidebar: [
      {
        text: 'User Guide',
        collapsed: false,
        items: [
          { text: 'Getting started', link: '/guide/getting-started' },
          { text: 'Your PADs', link: '/guide/agents' },
          { text: 'The terminal', link: '/guide/terminal' },
          { text: 'Sharing on the web', link: '/guide/web-publish' },
          { text: 'Keeping secrets', link: '/guide/vault' },
        ],
      },
      {
        text: 'Technical Reference',
        collapsed: true,
        items: [
          {
            text: 'Overview',
            collapsed: true,
            items: [
              { text: 'Docs map', link: '/README' },
              { text: 'Architecture', link: '/reference/overview/architecture' },
              { text: 'Business Logic', link: '/reference/overview/business-logic' },
              { text: 'React Migration', link: '/reference/overview/react-migration' },
            ],
          },
          {
            text: 'Backend',
            collapsed: true,
            items: [
              { text: 'Services', link: '/reference/backend/services' },
              { text: 'Drivers', link: '/reference/backend/drivers' },
              { text: 'Middleware', link: '/reference/backend/middleware' },
              { text: 'User Management', link: '/reference/backend/user-management' },
            ],
          },
          {
            text: 'Pages',
            collapsed: true,
            items: [
              { text: 'Overview', link: '/reference/pages/overview' },
            ],
          },
          {
            text: 'Agent Tabs',
            collapsed: true,
            items: [
              { text: 'Overview', link: '/reference/tabs/overview' },
              { text: 'Commands', link: '/reference/tabs/commands' },
              { text: 'Terminal', link: '/reference/tabs/terminal' },
              { text: 'Web & Ports', link: '/reference/tabs/web' },
              { text: 'Web Consoles', link: '/reference/tabs/web-consoles' },
              { text: 'Health', link: '/reference/tabs/health' },
              { text: 'MCP', link: '/reference/tabs/mcp' },
              { text: 'Skills', link: '/reference/tabs/skills' },
              { text: 'Settings', link: '/reference/tabs/settings' },
            ],
          },
          {
            text: 'Components',
            collapsed: true,
            items: [
              { text: 'Stats', link: '/reference/components/stats' },
              { text: 'Theme', link: '/reference/components/theme' },
              { text: 'UX', link: '/reference/components/ux' },
            ],
          },
          {
            text: 'Operations',
            collapsed: true,
            items: [
              { text: 'Overview', link: '/reference/operations/overview' },
              { text: 'OpenClaw', link: '/reference/operations/openclaw' },
            ],
          },
          {
            text: 'Style Guide',
            link: '/reference/STYLE-GUIDE',
          },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/craftpip/vm-friends' },
    ],

    footer: {
      message: 'Paddock runs on Docker.',
      copyright: 'Copyright © 2026 Paddock',
    },

    editLink: {
      pattern: 'https://github.com/craftpip/vm-friends/edit/master/docs/:path',
      text: 'Edit this page on GitHub',
    },

    search: {
      provider: 'local',
    },

    outline: {
      level: [2, 3],
      label: 'On this page',
    },

    lastUpdated: {
      text: 'Last updated',
      formatOptions: {
        dateStyle: 'medium',
        timeStyle: 'short',
      },
    },

    docFooter: {
      prev: 'Previous',
      next: 'Next',
    },

    returnToTopLabel: 'Back to top',
    sidebarMenuLabel: 'Menu',
    darkModeSwitchLabel: 'Appearance',
    lightModeSwitchTitle: 'Switch to light theme',
    darkModeSwitchTitle: 'Switch to dark theme',
  },

  markdown: {
    theme: {
      light: 'github-light',
      dark: 'github-dark',
    },
    lineNumbers: true,
  },

  sitemap: {
    hostname: 'https://example.com',
  },
})
