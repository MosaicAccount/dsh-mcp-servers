/**
 * 独立插件包的构建配置。
 *
 * 一次 `tsdown` 产出两个产物：
 *
 * - `lib/index.js` —— Cordis Loader 为 `dsh-mcp-servers` 那一行导入的 Node 半边。
 *   纯 ESM，无任何运行时依赖：schemastery 被内联，因此剩下的唯一裸标识符就是
 *   Loader 自己去解析的 bridge 包。
 * - `lib/client.js` —— 浏览器半边，采用 DSH Web 外壳客户端模块系统所服务的那种确切
 *   产物格式：一个惰性 CommonJS 工厂，交给
 *   `window.__ModuleLoader__.load({ id, factory })`，它的 `require` 由外壳冻结的模块
 *   表回答，而不是由打包器回答。
 *
 * 浏览器半边所需的一切都被内联；CSS Modules 也在这里编译（一个位于 harness 仓库
 * 之外的包拿不到它的构建插件）。
 *
 * @module dsh-mcp-servers/build
 */

import { readFile } from 'node:fs/promises'
import { dirname, resolve as resolvePath } from 'node:path'
import { transform } from 'lightningcss'
import { defineConfig } from 'tsdown'
import type { Plugin, UserConfig } from 'tsdown'

/** 包名，会写进模块加载交接协议，也会打在注入的 style 标签上。 */
const PACKAGE_NAME = 'dsh-mcp-servers'

/**
 * DSH Web 外壳已经共享进它那张冻结模块表的标识符。动态插件产物必须把这些保留为
 * `require(...)` 调用，这样每个插件看到的是同一个 React、Cordis 与 slots 实例；
 * 这里只是外壳自己那份列表的构建期镜像，不是可以自由选择的东西。
 */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

/**
 * 在基线之上、本包额外请求的模块表条目。本插件只通过 Cordis 服务触达 ui-settings 与
 * locale，因此没有额外请求。
 */
const REQUESTED_MODULES: readonly string[] = []

const CLIENT_EXTERNALS = new Set([...PLATFORM_MODULES, ...REQUESTED_MODULES])

/** 内置的框架库不承载跨插件的运行时同一性，因此直接内联。 */
const INLINE_SAFE = /^@deepseek-ai\/(cosmokit|schemastery)(\/|$)/

const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/** 生成一个插件自有的样式注入模块，外加 CSS Modules 的类名映射。 */
function styleInjectionModule(id: string, fileId: string, css: string, classMap: Record<string, string>): string {
  const tagId = `${id}/${fileId}`
  return [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(tagId)};`,
    'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
    '  const tag = document.createElement(\'style\');',
    `  tag.dataset.plugin = ${JSON.stringify(id)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
    `export default ${JSON.stringify(classMap)};`,
  ].join('\n')
}

/**
 * 把 `*.module.css` 编译成带哈希的类名映射，外加一个一次性的 style 标签。虚拟 id
 * 让样式表绕开 tsdown 自己的 CSS 管线，否则就需要再引入一个构建插件。
 */
function cssModulesPlugin(): Plugin {
  return {
    name: 'dsh-css-modules-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const absolute = importer === undefined ? source : resolvePath(dirname(importer), source)
      return CSS_VIRTUAL_PREFIX + absolute + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const { code, exports: cssExports } = transform({
        filename: fileId,
        code: await readFile(fileId),
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap: Record<string, string> = {}
      for (const [local, exported] of Object.entries(cssExports ?? {})) classMap[local] = exported.name
      return styleInjectionModule(PACKAGE_NAME, fileId, code.toString(), classMap)
    },
  }
}

/**
 * 在构建期拦下跨插件的值导入。模块表无法回答本包从未请求过的标识符，因此一个不小
 * 心的值导入要么会内联出另一份插件运行时，要么会在浏览器里直接抛错；跨插件协作应
 * 该走 Cordis 服务。
 */
function purityPlugin(): Plugin {
  return {
    name: 'dsh-client-bundle-purity',
    resolveId(source: string) {
      if (!source.startsWith('@deepseek-ai/')) return null
      if (CLIENT_EXTERNALS.has(source) || INLINE_SAFE.test(source)) return null
      throw new Error(
        `client bundle purity: "${source}" is neither a shell module-table entry nor an inline-safe library; `
        + 'import it with `import type` or collaborate through a Cordis service',
      )
    },
  }
}

/** Loader 导入的 Node 半边。 */
const host: UserConfig = {
  name: PACKAGE_NAME,
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2023',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: {
    // schemastery 以及其他所有裸标识符都被内联：发布出去的包不存在解析不到的运行时
    // 依赖。bridge 根本不会被导入——Loader 是用配置行里的名字去解析它的。
    neverBundle: () => false,
    alwaysBundle: () => true,
  },
}

/** 浏览器半边，采用外壳的动态插件产物格式。 */
const client: UserConfig = {
  name: `${PACKAGE_NAME}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  target: 'es2023',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: (specifier: string) => CLIENT_EXTERNALS.has(specifier),
    alwaysBundle: (specifier: string) => !CLIENT_EXTERNALS.has(specifier),
  },
  inputOptions: {
    resolve: {
      conditionNames: ['production', 'browser', 'import', 'module', 'default'],
    },
  },
  // 浏览器产物会内联那些读取构建期全局量的依赖（zustand 会探测 `import.meta.env`），
  // 而 CommonJS 输出承载不了它。
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'import.meta.env.MODE': JSON.stringify('production'),
    'import.meta.env': JSON.stringify({ MODE: 'production' }),
  },
  plugins: [purityPlugin(), cssModulesPlugin()],
  outputOptions: {
    entryFileNames: 'client.js',
    sourcemapExcludeSources: false,
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default defineConfig([host, client])
