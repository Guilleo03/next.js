import type {
  GetServerSideProps,
  GetServerSidePropsResult,
  GetStaticPaths,
  GetStaticProps,
  GetStaticPropsResult,
  PageConfig,
  PreviewData,
  ServerRuntime,
} from '../../../../../types'
import type { BuildManifest } from '../../../get-page-files'
import type {
  ManifestItem,
  ReactLoadableManifest,
} from '../../../load-components'
import type { NextRequest } from '../../../web/spec-extension/request'
import type { PagesRouteDefinition } from '../../route-definitions/pages-route-definition'
import type { ParsedUrlQuery } from 'querystring'
import type { NextConfigComplete } from '../../../config-shared'
import type { FontManifest } from '../../../font-utils'

import {
  type AppType,
  type ComponentsEnhancer,
  type DocumentContext,
  type DocumentInitialProps,
  type DocumentProps,
  type DocumentType,
  type NextComponentType,
  type RenderPage,
  type RenderPageResult,
  getDisplayName,
  isResSent,
} from '../../../../shared/lib/utils'
import React from 'react'
import ReactDOMServer from 'react-dom/server.browser'
import {
  SSG_GET_INITIAL_PROPS_CONFLICT,
  SERVER_PROPS_GET_INIT_PROPS_CONFLICT,
  SERVER_PROPS_SSG_CONFLICT,
  GSSP_COMPONENT_MEMBER_ERROR,
  STATIC_STATUS_PAGE_GET_INITIAL_PROPS_ERROR,
  SERVER_PROPS_EXPORT_ERROR,
} from '../../../../lib/constants'
import { RouteKind } from '../../route-kind'
import {
  RouteModule,
  type RouteModuleHandleContext,
  type RouteModuleOptions,
} from '../route-module'
import { isDynamicRoute } from '../../../../shared/lib/router/utils'
import logger from '../helpers/logging'
import { ServerRouter } from './helpers/server-router'
import { StyleRegistry, createStyleRegistry } from 'styled-jsx'
import { HeadManagerContext } from '../../../../shared/lib/head-manager-context'
import { isInAmpMode } from '../../../../shared/lib/amp-mode'
import { defaultHead } from '../../../../shared/lib/head'
import { AmpStateContext } from '../../../../shared/lib/amp-context'
import { ImageConfigContext } from '../../../../shared/lib/image-config-context'
import { LoadableContext } from '../../../../shared/lib/loadable-context'
import { RouterContext } from '../../../../shared/lib/router-context'
import { loadGetInitialProps } from '../../../../shared/lib/utils'
import {
  NEXT_BUILTIN_DOCUMENT,
  SERVER_PROPS_ID,
  STATIC_PROPS_ID,
} from '../../../../shared/lib/constants'
import { getTracer } from '../../../lib/trace/tracer'
import { RenderSpan } from '../../../lib/trace/constants'
import {
  validateGetServerSideProps,
  validateGetStaticProps,
} from './helpers/validate-props'
import RenderResult, { RenderResultMetadata } from '../../../render-result'
import {
  RedirectPropsResult,
  checkRedirectValues,
} from './helpers/check-redirect-values'
import { isSerializableProps } from '../../../../lib/is-serializable-props'
import { validateRevalidate } from './helpers/validate-revalidate'
import { proxyResponse } from './helpers/proxy-response'
import { IncomingMessage, ServerResponse } from 'http'
import isError from '../../../../lib/is-error'
import { denormalizePagePath } from '../../../../shared/lib/page-path/denormalize-page-path'
import { normalizePagePath } from '../../../../shared/lib/page-path/normalize-page-path'
import {
  ReactReadableStream,
  chainStreams,
  continueFromInitialStream,
  renderToInitialStream,
  streamFromArray,
  streamToString,
} from '../../../node-web-streams-helper'
import { renderToString } from './helpers/render-to-string'
import {
  createAppContainerWithIsomorphicFiberStructure,
  createBody,
  createErrorDebug,
} from './helpers/create-components'
import { enhanceComponents } from './helpers/enhance-components'
import { postProcessHTML } from '../../../post-process'
import { HtmlContext, HtmlProps } from '../../../../shared/lib/html-context'
import { serializeError } from './helpers/serialize-error'
import { NextParsedUrlQuery, getRequestMeta } from '../../../request-meta'
import { NextFontManifest } from '../../../../build/webpack/plugins/next-font-manifest-plugin'
import { renderPageTree } from './helpers/render-page-tree'
import { renderResultToResponse } from '../helpers/render-result-to-response'
import { MockedResponse } from '../../../lib/mock-request'
import { wrapAppContainer } from './helpers/wrap-app-container'
import Loadable from '../../../../shared/lib/loadable'
import { createAMPValidator } from './helpers/amp-validator'
import { PrerenderManifest } from '../../../../build'
import { tryGetPreviewData } from './helpers/try-get-preview-data'

const DOCTYPE = '<!DOCTYPE html>'

/**
 * The userland module for a page. This is the module that is exported from the
 * page file that contains the page component, page config, and any page data
 * fetching functions.
 */
type PagesUserlandModule = {
  /**
   * The exported page component.
   */
  readonly default: NextComponentType

  /**
   * The exported page config.
   */
  readonly config?: PageConfig

  /**
   * The exported `getStaticProps` function.
   */
  readonly getStaticProps?: GetStaticProps

  /**
   * The exported `getStaticPaths` function.
   */
  readonly getStaticPaths?: GetStaticPaths

  /**
   * The exported `getServerSideProps` function.
   */
  readonly getServerSideProps?: GetServerSideProps
}

/**
 * The components that are used to render a page. These aren't tied to the
 * specific page being rendered, but rather are the components that are used to
 * render all pages.
 */
type PagesComponents = {
  /**
   * The `App` component. This could be exported by a user's custom `_app` page
   * file, or it could be the default `App` component.
   */
  readonly App: AppType

  /**
   * The `Document` component. This could be exported by a user's custom
   * `_document` page file, or it could be the default `Document` component.
   */
  readonly Document: DocumentType
}

export type PagesManifests = {
  readonly build: BuildManifest
  readonly subresourceIntegrity: Record<string, string> | undefined
  readonly reactLoadable: ReactLoadableManifest
  readonly font: FontManifest | undefined
  readonly nextFont: NextFontManifest | undefined
  readonly prerender: PrerenderManifest | undefined
}

interface RouteRenderOptions {
  readonly dev: boolean
  readonly buildId: string
  readonly disableOptimizedLoading: boolean
}

export interface PagesRouteModuleOptions
  extends RouteModuleOptions<PagesUserlandModule> {
  readonly page: string
  readonly components: PagesComponents
  readonly config: PagesRouteConfig
  readonly renderOpts: RouteRenderOptions
}

export interface PagesRouteHandlerContext extends RouteModuleHandleContext {
  manifests: PagesManifests
  renderOpts: {
    page: string
    statusCode: number
    ampPath: string | undefined
    customServer: boolean | undefined
    distDir: string | undefined
    isDataReq: boolean | undefined
    resolvedAsPath: string | undefined
    query: NextParsedUrlQuery
    resolvedUrl: string
    err: Error | null | undefined
    runtime: ServerRuntime | undefined
    runtimeConfig: { [key: string]: any } | undefined
    locale: string | undefined
    locales: string[] | undefined
    defaultLocale: string | undefined
    isLocaleDomain: boolean | undefined
  }
}

interface PagesRouteHandlerRenderContext extends PagesRouteHandlerContext {
  readonly req?: IncomingMessage
  readonly res: ServerResponse
  readonly isPreviewMode: boolean
  readonly previewData: PreviewData | undefined
}

type PagesRouteConfig = Pick<
  NextConfigComplete,
  | 'amp'
  | 'output'
  | 'images'
  | 'i18n'
  | 'assetPrefix'
  | 'basePath'
  | 'optimizeFonts'
  | 'poweredByHeader'
  | 'generateEtags'
  | 'assetPrefix'
  | 'crossOrigin'
> & {
  experimental: Pick<
    NextConfigComplete['experimental'],
    | 'appDir'
    | 'optimizeCss'
    | 'strictNextHead'
    | 'amp'
    | 'nextScriptWorkers'
    | 'largePageDataBytes'
  >
}

type Props = {
  __N_PREVIEW?: boolean

  [STATIC_PROPS_ID]?: boolean
  [SERVER_PROPS_ID]?: boolean

  pageProps?: {}
}

export class PagesRouteModule extends RouteModule<
  PagesRouteDefinition,
  PagesUserlandModule
> {
  public readonly definition: PagesRouteDefinition
  public readonly config: PagesRouteConfig
  public readonly isDynamic: boolean
  public readonly components: PagesComponents
  public readonly amp: boolean | 'hybrid'

  private readonly renderOpts: RouteRenderOptions

  public constructor({
    renderOpts,
    userland,
    page,
    components,
    config,
  }: PagesRouteModuleOptions) {
    super({ userland })

    this.definition = {
      kind: RouteKind.PAGES,
      page,
      // The following aren't needed for the route handler.
      pathname: '',
      bundlePath: '',
      filename: '',
    }

    this.renderOpts = renderOpts
    this.isDynamic = isDynamicRoute(page)
    this.components = components
    this.config = config
    this.amp = userland.config?.amp ?? false
  }

  /**
   * Performs the initial setup for the module. This is called once when the
   * module handle is called.
   *
   * @param nextExport Whether or not the app is being exported.
   * @param dev Whether or not the app is doing a development build.
   */
  public setup(
    page: string,
    nextExport: boolean | undefined,
    dev: boolean | undefined
  ): void {
    const {
      default: Component,
      getServerSideProps,
      getStaticProps,
      getStaticPaths,
      default: { getInitialProps, origGetInitialProps },
    } = this.userland
    const { App, Document } = this.components

    // Warn about usage of `getInitialProps` in a page while running export.
    // This is only done for pages that are not `_error` since `_error` is
    // special and is handled by `next export` itself.
    if (
      nextExport &&
      getInitialProps &&
      (page !== '/_error' || getInitialProps !== origGetInitialProps)
    ) {
      logger.warn(
        `Detected getInitialProps on page '${page}'` +
          ` while running export. It's recommended to use getStaticProps` +
          ` which has a more correct behavior for static exporting.` +
          `\nRead more: https://nextjs.org/docs/messages/get-initial-props-export`
      )
    }

    // Error if the component exports `getServerSideProps` while we are
    // exporting.
    if (nextExport && getServerSideProps) {
      throw new Error(`Error for page ${page}: ${SERVER_PROPS_EXPORT_ERROR}`)
    }

    // Error on usage of both `getStaticProps` and `getInitialProps`.
    if (getStaticProps && getInitialProps) {
      throw new Error(SSG_GET_INITIAL_PROPS_CONFLICT + ` ${page}`)
    }

    // Error on usage of both `getServerSideProps` and `getInitialProps`.
    if (getServerSideProps && getInitialProps) {
      throw new Error(SERVER_PROPS_GET_INIT_PROPS_CONFLICT + ` ${page}`)
    }

    // Error on usage of both `getServerSideProps` and `getStaticProps`.
    if (getServerSideProps && getStaticProps) {
      throw new Error(SERVER_PROPS_SSG_CONFLICT + ` ${page}`)
    }

    // Error when using `getServerSideProps` with `output: 'export'`.
    if (getServerSideProps && this.config.output === 'export') {
      throw new Error(
        'getServerSideProps cannot be used with "output: export". See more info here: https://nextjs.org/docs/advanced-features/static-html-export'
      )
    }

    // Error when there is `getStaticPaths` and the route is not dynamic.
    if (getStaticPaths && !this.isDynamic) {
      throw new Error(
        `getStaticPaths is only allowed for dynamic SSG pages and was found on "${page}".\nRead more: https://nextjs.org/docs/messages/non-dynamic-getstaticpaths-usage`
      )
    }

    // Error when there is `getStaticPaths but no `getStaticProps`.
    if (getStaticPaths && !getStaticProps) {
      throw new Error(
        `getStaticPaths was added without a getStaticProps in ${page}. Without getStaticProps, getStaticPaths does nothing`
      )
    }

    // Error if `getStaticProps` is used without `getStaticPaths` when the page
    // is dynamic.
    if (this.isDynamic && getStaticProps && !getStaticPaths) {
      throw new Error(
        `getStaticPaths is required for dynamic SSG pages and is missing for ${page}.\nRead more: https://nextjs.org/docs/messages/invalid-getstaticpaths-value`
      )
    }

    // Error if any of the userland methods are defined on the component, this
    // is likely a mistake.
    for (const method of [
      'getStaticProps',
      'getStaticPaths',
      'getServerSideProps',
    ]) {
      if (method in Component) {
        throw new Error(`page${page} ${method} ${GSSP_COMPONENT_MEMBER_ERROR}`)
      }
    }

    // Run the following validations only in development.
    if (dev) {
      // Check that the components that we're going to render are valid React
      // components.
      const { isValidElementType } =
        require('next/dist/compiled/react-is') as typeof import('next/dist/compiled/react-is')
      if (!isValidElementType(Component)) {
        throw new Error(
          `The default export is not a React Component in page: "${page}"`
        )
      }

      if (!isValidElementType(App)) {
        throw new Error(
          `The default export is not a React Component in page: "/_app"`
        )
      }

      if (!isValidElementType(Document)) {
        throw new Error(
          `The default export is not a React Component in page: "/_document"`
        )
      }

      // Error if `getServerSideProps` or `getInitialProps` is used in a /404
      // or /500 page.
      for (const pathname of ['/404', '/500']) {
        if (page === pathname && (getServerSideProps || getInitialProps)) {
          throw new Error(
            `\`pages${pathname}\` ${STATIC_STATUS_PAGE_GET_INITIAL_PROPS_ERROR}`
          )
        }
      }
    }
  }

  public async handle(
    request: NextRequest,
    context: PagesRouteHandlerContext
  ): Promise<Response> {
    // Perform the setup and validation of the userland module.
    this.setup(context.renderOpts.page, context.export, this.renderOpts.dev)

    // Create the mock response that will be used to record and interact with
    // the page handlers.
    const res = new MockedResponse()

    // This is only available when we aren't in the edge runtime, otherwise it
    // will be undefined.
    const req =
      request.request && 'originalRequest' in request.request
        ? request.request?.originalRequest
        : undefined

    // Check to see if we're in preview mode.
    let previewData: PreviewData
    let isPreviewMode = false

    if (
      // This isn't supported in the edge runtime, so check to see if the
      // function is available.
      req &&
      tryGetPreviewData &&
      context.manifests.prerender &&
      // Preview mode is only supported on pages with `getStaticProps` or
      // `getServerSideProps`.
      (typeof this.userland.getServerSideProps === 'function' ||
        typeof this.userland.getStaticProps === 'function')
    ) {
      previewData = tryGetPreviewData(
        req,
        res,
        context.manifests.prerender.preview
      )
      isPreviewMode = previewData !== false
    }

    // Render the page.
    const result = await this.render(request, {
      ...context,
      req,
      res,
      previewData,
      isPreviewMode,
    })

    // Render the result to a response.
    return await this.transform(request, result, {
      res,
      isResSent: isResSent(res),
      isDataReq: context.renderOpts.isDataReq === true,
      isPreviewMode,
    })
  }

  public async transform(
    request: NextRequest,
    result: RenderResult,
    context: {
      res: MockedResponse
      isResSent: boolean
      isDataReq: boolean
      isPreviewMode: boolean
    }
  ): Promise<Response> {
    return await renderResultToResponse(
      request,
      result,
      {
        dev: this.renderOpts.dev,
        basePath: this.config.basePath,
        definition: this.definition,
        hasGetStaticProps: typeof this.userland.getStaticProps === 'function',
        poweredByHeader: this.config.poweredByHeader,
        generateEtags: this.config.generateEtags,
      },
      {
        res: context.res,
        isResSent: context.isResSent,
        isDataReq: context.isDataReq,
        isPreviewMode: context.isPreviewMode,
      }
    )
  }

  public async render(
    request: NextRequest,
    context: PagesRouteHandlerRenderContext
  ): Promise<RenderResult> {
    const {
      default: Component,
      getServerSideProps,
      getStaticProps,
      default: { getInitialProps },
    } = this.userland
    const { App } = this.components
    let { Document } = this.components

    const metadata: RenderResultMetadata = {}

    // In dev we invalidate the cache by appending a timestamp to the resource URL.
    // This is a workaround to fix https://github.com/vercel/next.js/issues/5860
    // TODO: remove this workaround when https://bugs.webkit.org/show_bug.cgi?id=187726 is fixed.
    metadata.devOnlyCacheBusterQueryString = this.renderOpts.dev
      ? `?ts=${Date.now()}`
      : ''

    // The app has a custom `getInitialProps` method if the `pages/_app` has a
    // `getInitialProps` method that is equal to the `origGetInitialProps`
    // method.
    const appHasDefaultGetInitialProps =
      App.getInitialProps === App.origGetInitialProps

    // The router is ready when there is a `getServerSideProps` or
    // `getInitialProps` method. It is also ready when the `pages/_app` has a
    // custom `getInitialProps` method and there is a `getStaticProps` method.
    const routerIsReady: boolean =
      typeof getServerSideProps === 'function' ||
      typeof getInitialProps === 'function' ||
      (!appHasDefaultGetInitialProps && typeof getStaticProps === 'function')

    // The page is automatically exported when there is no `getInitialProps`,
    // `getServerSideProps`, `getStaticProps` methods and the `pages/_app` has
    // a default `getInitialProps` method.
    const isAutoExport =
      !(typeof getInitialProps === 'function') &&
      !(typeof getStaticProps === 'function') &&
      !(typeof getServerSideProps === 'function') &&
      appHasDefaultGetInitialProps

    // Pull some values off of the request context.
    const { isLocaleDomain = false, resolvedUrl } = context.renderOpts

    // This is the pathname that matched this route.
    // FIXME: (wyattjoh) check to see if this is the right pathname? We may need the route definition's pathname instead
    const pathname: string = request.nextUrl.pathname

    let { query } = context.renderOpts
    let asPath = context.renderOpts.resolvedAsPath || request.url
    const isFallback: boolean = !!query.__nextFallback
    const notFoundSrcPage = query.__nextNotFoundSrcPage

    // We only need to perform this transformation in development because when
    // we're in production we're serving the static files that are already
    // transformed during build.
    if (this.renderOpts.dev) {
      // If we're exporting the page during automatic export or when rendering a
      // fallback page during a development build,
      if (isAutoExport || isFallback) {
        // Remove all the query parameters except those set during export. Right
        // now this is just `amp`.
        query = query.amp ? { amp: query.amp } : {}

        asPath = pathname

        // Ensure trailing slash is present for non-dynamic auto-export pages.
        if (!this.isDynamic && request.url.endsWith('/') && pathname !== '/') {
          asPath += '/'
        }

        // FIXME: (wyattjoh) this seems like a bug. We're mutating the request object here.
        request.nextUrl.pathname = pathname
      }
    }

    // Make sure all dynamic imports are loaded.
    await Loadable.preloadAll()

    // We can't use preview data if we're not rendering the fallback page.
    const isPreview = !isFallback ? context.isPreviewMode : false
    const previewData = !isFallback ? context.previewData : undefined

    // Create the server router for the render.
    const router = new ServerRouter({
      pathname: pathname,
      query,
      asPath,
      basePath: this.config.basePath,
      isFallback,
      locale: context.renderOpts.locale,
      isReady: routerIsReady,
      defaultLocale: context.renderOpts.defaultLocale,
      locales: context.renderOpts.locales,
      domainLocales: this.config.i18n?.domains,
      isPreview,
      isLocaleDomain,
    })

    let scriptLoader = {}
    const jsxStyleRegistry = createStyleRegistry()
    const ampState = {
      ampFirst: this.userland.config?.amp === true,
      hasQuery: Boolean(query.amp),
      hybrid: this.userland.config?.amp === 'hybrid',
    }

    // Disable AMP under the web environment
    const inAmpMode =
      process.env.NEXT_RUNTIME !== 'edge' && isInAmpMode(ampState)
    let head: JSX.Element[] = defaultHead(inAmpMode)
    const reactLoadableModules: string[] = []

    const initialScripts: any = {}
    if (Component.unstable_scriptLoader) {
      initialScripts.beforeInteractive = Component.unstable_scriptLoader()
        .filter((script) => script.props.strategy === 'beforeInteractive')
        .map((script) => script.props)
    }

    let AppContainer = (props: { children: JSX.Element }): JSX.Element => (
      <ImageConfigContext.Provider value={this.config.images}>
        <RouterContext.Provider value={router}>
          <AmpStateContext.Provider value={ampState}>
            <HeadManagerContext.Provider
              value={{
                updateHead: (state) => {
                  head = state
                },
                updateScripts: (scripts) => {
                  scriptLoader = scripts
                },
                scripts: initialScripts,
                mountedInstances: new Set(),
              }}
            >
              <LoadableContext.Provider
                value={(moduleName) => reactLoadableModules.push(moduleName)}
              >
                <StyleRegistry registry={jsxStyleRegistry}>
                  {props.children}
                </StyleRegistry>
              </LoadableContext.Provider>
            </HeadManagerContext.Provider>
          </AmpStateContext.Provider>
        </RouterContext.Provider>
      </ImageConfigContext.Provider>
    )

    // Ideally, we want to only wrap the app container if the app has the
    // app directory enabled. However folks may still try to use the new hooks
    // in pages, so always wrap.
    AppContainer = wrapAppContainer(AppContainer, {
      router,
      isAutoExport,
      isDynamic: this.isDynamic,
    })

    // The `useId` API uses the path indexes to generate an ID for each node.
    // To guarantee the match of hydration, we need to ensure that the structure
    // of wrapper nodes is isomorphic in server and client.
    // TODO: With `enhanceApp` and `enhanceComponents` options, this approach may
    // not be useful.
    // https://github.com/facebook/react/pull/22644

    const AppContainerWithIsomorphicFiberStructure =
      createAppContainerWithIsomorphicFiberStructure(AppContainer, {
        dev: this.renderOpts.dev,
      })

    const ctx = {
      err: context.renderOpts.err,
      req: isAutoExport ? undefined : context.req,
      res: isAutoExport ? undefined : context.res,
      pathname,
      query,
      asPath,
      locale: context.renderOpts.locale,
      locales: context.renderOpts.locales,
      defaultLocale: context.renderOpts.defaultLocale,
      AppTree: (props: any) => {
        return (
          <AppContainerWithIsomorphicFiberStructure>
            {renderPageTree(App, Component, { ...props, router })}
          </AppContainerWithIsomorphicFiberStructure>
        )
      },
      defaultGetInitialProps: async (
        docCtx: DocumentContext,
        options: { nonce?: string } = {}
      ): Promise<DocumentInitialProps> => {
        const enhanceApp = (AppComp: any) => {
          return (props: any) => <AppComp {...props} />
        }

        const { html, head: renderPageHead } = await docCtx.renderPage({
          enhanceApp,
        })
        const styles = jsxStyleRegistry.styles({ nonce: options.nonce })
        jsxStyleRegistry.flush()
        return { html, head: renderPageHead, styles }
      },
    }

    const nextExport =
      !(typeof getStaticProps === 'function') &&
      (context.export || (this.renderOpts.dev && (isAutoExport || isFallback)))

    const styledJsxInsertedHTML = (): JSX.Element => {
      const styles = jsxStyleRegistry.styles()
      jsxStyleRegistry.flush()
      return <>{styles}</>
    }

    // Load the initial props used for rendering the page.
    const props: Props = await loadGetInitialProps(App, {
      AppTree: ctx.AppTree,
      Component,
      router,
      ctx,
    })

    // If this has `getStaticProps` or `getServerSideProps` we need to mark it
    // as preview if this is a preview request.
    if (
      (typeof getStaticProps === 'function' ||
        typeof getServerSideProps === 'function') &&
      isPreview
    ) {
      props.__N_PREVIEW = true
    }

    // If this page has static props, we should mark it as such.
    if (typeof getStaticProps === 'function') {
      props[STATIC_PROPS_ID] = true

      // If this page has static props and isn't a fallback we should try to get
      // the static props.
      if (!isFallback) {
        let data: GetStaticPropsResult<unknown> | RedirectPropsResult

        try {
          data = await getTracer().trace(
            RenderSpan.getStaticProps,
            {
              spanName: `getStaticProps ${pathname}`,
              attributes: {
                'next.route': pathname,
              },
            },
            () =>
              getStaticProps({
                ...(this.isDynamic
                  ? { params: query as ParsedUrlQuery }
                  : undefined),
                ...(isPreview ? { preview: true, previewData } : undefined),
                locales: context.renderOpts.locales,
                locale: context.renderOpts.locale,
                defaultLocale: context.renderOpts.defaultLocale,
              })
          )
        } catch (err) {
          // Remove not found error code to prevent triggering legacy
          // 404 rendering.
          if (isError(err) && err.code === 'ENOENT') {
            delete err.code
          }

          throw err
        }

        // Ensure that the user did not include any invalid keys in the returned
        // data from `getStaticProps`.
        validateGetStaticProps(data)

        // If we're in development, we should warn the user if they're using
        // conflicting keys in the return value of `getStaticProps`.
        if (process.env.NODE_ENV !== 'production') {
          if ('notFound' in data && 'redirect' in data) {
            throw new Error(
              `\`redirect\` and \`notFound\` can not both be returned from getStaticProps` +
                `at the same time. Page: ${pathname}` +
                `\nSee more info here: https://nextjs.org/docs/messages/gssp-mixed-not-found-redirect`
            )
          }
        }

        // Handle notFound.
        if ('notFound' in data && data.notFound) {
          // If the /404 page returns `notFound: true` we should error.
          if (pathname === '/404') {
            throw new Error(
              `The /404 page can not return notFound in "getStaticProps", please remove it to continue!`
            )
          }

          metadata.isNotFound = true
        }

        // Handle redirect.
        if (
          'redirect' in data &&
          data.redirect &&
          typeof data.redirect === 'object'
        ) {
          // Because this was a redirect, we need to update the internal data so
          // that this results in a redirect.
          data = checkRedirectValues(data, request.url, 'getStaticProps')

          if (context.export) {
            throw new Error(
              `\`redirect\` can not be returned from getStaticProps during prerendering (${request.url})\n` +
                `See more info here: https://nextjs.org/docs/messages/gsp-redirect-during-prerender`
            )
          }

          metadata.isRedirect = true
        }

        // Handle revalidate.
        if ('revalidate' in data) {
          // Validate and coerce `revalidate`.
          metadata.revalidate = validateRevalidate(data.revalidate, request.url)

          // TODO: (wyattjoh) should we error if `context.nextExport` is true?
          if (metadata.revalidate && this.config.output === 'export') {
            throw new Error(
              'ISR cannot be used with "output: export". See more info here: https://nextjs.org/docs/advanced-features/static-html-export'
            )
          }
        }

        // If we're in development or exporting and the page is not a 404 page
        // and the result of `getStaticProps` is not serializable we should throw
        // an error.
        if (
          (this.renderOpts.dev || context.export) &&
          'props' in data &&
          !isSerializableProps(pathname, 'getStaticProps', data.props)
        ) {
          throw new Error(
            'Invariant: getStaticProps did not return valid props. Please report this.'
          )
        }

        // Merge in the props from `getStaticProps` into the page's props.
        if ('props' in data && data.props) {
          props.pageProps = Object.assign({}, props.pageProps, data.props)
        }

        // Merge in the props into the page data metadata.
        metadata.pageData = props

        // this must come after revalidate is added to renderResultMeta
        if (metadata.isNotFound) {
          return new RenderResult(null, metadata)
        }
      }
    }

    // If this page has server side props, we should mark it as such.
    if (typeof getServerSideProps === 'function') {
      props[SERVER_PROPS_ID] = true

      // If this page has server side props and isn't a fallback we should try to
      // get the server side props.
      if (!isFallback) {
        let data: GetServerSidePropsResult<unknown> | RedirectPropsResult

        const proxyCtx = {
          hasResolved: false,
          isDeferred: false,
        }

        try {
          data = await getTracer().trace(
            RenderSpan.getServerSideProps,
            {
              spanName: `getServerSideProps ${pathname}`,
              attributes: {
                'next.route': pathname,
              },
            },
            async () =>
              getServerSideProps({
                req:
                  context.req ??
                  ({
                    url: request.url,
                    method: request.method,
                    cookies: request.cookies,
                    headers: request.headers,
                    body: request.body,
                    // FIXME: (wyattjoh) fix this type, mirroring https://github.com/vercel/next.js/blob/d9e3803e6481f772c6a2c553330cfc6bed759977/packages/next/src/server/web-server.ts#L379-L385
                  } as any),
                res: proxyResponse(context.res, proxyCtx),
                query,
                resolvedUrl,
                ...(this.isDynamic ? { params: context.params } : undefined),
                ...(previewData !== false
                  ? { preview: true, previewData: previewData }
                  : undefined),
                locales: context.renderOpts.locales,
                locale: context.renderOpts.locale,
                defaultLocale: context.renderOpts.defaultLocale,
              })
          )

          // Mark that the `getServerSideProps` has resolved. This is used to
          // ensure that the proxy response is not written to after the
          // `getServerSideProps` has returned.
          proxyCtx.hasResolved = true
        } catch (err) {
          // Remove not found error code to prevent triggering legacy
          // 404 rendering.
          if (isError(err) && err.code === 'ENOENT') {
            delete err.code
          }

          throw err
        }

        // If the user returned a promise, mark the response as deferred.
        if ('props' in data && data.props instanceof Promise) {
          proxyCtx.isDeferred = true
        }

        // Ensure that the user did not include any invalid keys in the returned
        // data from `getStaticProps`.
        validateGetServerSideProps(data)

        // Handle notFound.
        if ('notFound' in data && data.notFound) {
          if (pathname === '/404') {
            throw new Error(
              `The /404 page can not return notFound in "getStaticProps", please remove it to continue!`
            )
          }

          metadata.isNotFound = true
          return new RenderResult(null, metadata)
        }

        // Handle redirect.
        if (
          'redirect' in data &&
          data.redirect &&
          typeof data.redirect === 'object'
        ) {
          data = checkRedirectValues(data, request.url, 'getServerSideProps')

          metadata.isRedirect = true
        }

        if ('props' in data && data.props instanceof Promise) {
          data.props = await data.props
        }

        // If we're in development or exporting and the page is not a 404 page
        // and the result of `getServerSideProps` is not serializable we should throw
        // an error.
        if (
          (this.renderOpts.dev || context.export) &&
          'props' in data &&
          !isSerializableProps(pathname, 'getServerSideProps', data.props)
        ) {
          throw new Error(
            'Invariant: getServerSideProps did not return valid props. Please report this.'
          )
        }

        // Merge in the props from `getServerSideProps` into the page's props.
        if ('props' in data && typeof data.props !== 'undefined') {
          props.pageProps = Object.assign({}, props.pageProps, data.props)
        }

        // Merge in the props into the page data metadata.
        metadata.pageData = props
      }
    }

    // Warn about the `pageProps` returning the `url` reserved prop.
    if (
      typeof getStaticProps !== 'function' &&
      typeof getServerSideProps !== 'function' &&
      process.env.NODE_ENV !== 'production' &&
      'pageProps' in props &&
      typeof props.pageProps === 'object' &&
      Object.keys(props.pageProps).includes('url')
    ) {
      logger.warn(
        `The prop \`url\` is a reserved prop in Next.js for legacy reasons and will be overridden on page ${pathname}\n` +
          `See more info here: https://nextjs.org/docs/messages/reserved-page-prop`
      )
    }

    // Avoid rendering page un-necessarily for `getServerSideProps` data request
    // and `getServerSideProps`/`getStaticProps` redirects.
    if (
      (context.renderOpts.isDataReq &&
        typeof getServerSideProps === 'function') ||
      metadata.isRedirect
    ) {
      return new RenderResult(JSON.stringify(props), metadata)
    }

    // FIXME: (wyattjoh) this shouldn't be required
    // // We don't call getStaticProps or getServerSideProps while generating
    // // the fallback so make sure to set pageProps to an empty object
    // if (isFallback) {
    //   props.pageProps = {}
    // }

    // The response might be finished on the getInitialProps call.
    if (isResSent(context.res) && typeof getStaticProps !== 'function') {
      return new RenderResult(null, metadata)
    }

    // Let's preload the build manifest for auto-export dynamic pages to speed
    // up hydrating query values.
    let filteredBuildManifest = context.manifests.build
    if (isAutoExport && this.isDynamic) {
      const page = denormalizePagePath(normalizePagePath(pathname))
      // This code would be much cleaner using `immer` and directly pushing into
      // the result from `getPageFiles`, we could maybe consider that in the
      // future.
      if (page in filteredBuildManifest.pages) {
        filteredBuildManifest = {
          ...filteredBuildManifest,
          pages: {
            ...filteredBuildManifest.pages,
            [page]: [
              ...filteredBuildManifest.pages[page],
              ...filteredBuildManifest.lowPriorityFiles.filter((f) =>
                f.includes('_buildManifest')
              ),
            ],
          },
          lowPriorityFiles: filteredBuildManifest.lowPriorityFiles.filter(
            (f) => !f.includes('_buildManifest')
          ),
        }
      }
    }

    const Body = createBody(inAmpMode)
    const ErrorDebug = createErrorDebug(this.renderOpts.dev)

    const renderDocument = async () => {
      // For `Document`, there are two cases that we don't support:
      // 1. Using `Document.getInitialProps` in the Edge runtime.
      // 2. Using the class component `Document` with concurrent features.
      if (process.env.NEXT_RUNTIME === 'edge' && Document.getInitialProps) {
        // TODO: (wyattjoh) fix this type
        const BuiltinFunctionalDocument: DocumentType | undefined = (
          Document as any
        )[NEXT_BUILTIN_DOCUMENT]

        // In the Edge runtime, `Document.getInitialProps` isn't supported.
        // We throw an error here if it's customized.
        if (BuiltinFunctionalDocument) {
          Document = BuiltinFunctionalDocument
        } else {
          throw new Error(
            '`getInitialProps` in Document component is not supported with the Edge Runtime.'
          )
        }
      }

      const loadDocumentInitialProps = async (
        renderShell?: (
          _App: AppType,
          _Component: NextComponentType
        ) => Promise<ReactReadableStream>
      ) => {
        const renderPage: RenderPage = async (
          options: ComponentsEnhancer = {}
        ): Promise<RenderPageResult> => {
          if (ctx.err && ErrorDebug) {
            // Always start rendering the shell even if there's an error.
            if (renderShell) {
              renderShell(App, Component)
            }

            const html = await renderToString(
              <Body>
                <ErrorDebug error={ctx.err} />
              </Body>
            )
            return { html, head }
          }

          // Validate that the props returned do not contain next props.
          if (
            this.renderOpts.dev &&
            ('router' in props || 'Component' in props)
          ) {
            throw new Error(
              `'router' and 'Component' can not be returned in getInitialProps from pages/_app https://nextjs.org/docs/messages/cant-override-next-props`
            )
          }

          const { App: EnhancedApp, Component: EnhancedComponent } =
            enhanceComponents(options, App, Component)

          if (renderShell) {
            return renderShell(EnhancedApp, EnhancedComponent).then(
              async (stream) => {
                await stream.allReady
                const html = await streamToString(stream)
                return { html, head }
              }
            )
          }

          const html = await renderToString(
            <Body>
              <AppContainerWithIsomorphicFiberStructure>
                {renderPageTree(EnhancedApp, EnhancedComponent, {
                  ...props,
                  router,
                })}
              </AppContainerWithIsomorphicFiberStructure>
            </Body>
          )
          return { html, head }
        }
        const documentCtx = { ...ctx, renderPage }
        const docProps: DocumentInitialProps = await loadGetInitialProps(
          Document,
          documentCtx
        )

        // The response might be finished on the getInitialProps call.
        if (isResSent(context.res) && typeof getStaticProps === 'function') {
          return null
        }

        if (!docProps || typeof docProps.html !== 'string') {
          const message = `"${getDisplayName(
            Document
          )}.getInitialProps()" should resolve to an object with a "html" prop set with a valid html string`
          throw new Error(message)
        }

        return { docProps, documentCtx }
      }

      const renderContent = (_App: AppType, _Component: NextComponentType) => {
        const EnhancedApp = _App || App
        const EnhancedComponent = _Component || Component

        return ctx.err && ErrorDebug ? (
          <Body>
            <ErrorDebug error={ctx.err} />
          </Body>
        ) : (
          <Body>
            <AppContainerWithIsomorphicFiberStructure>
              {renderPageTree(EnhancedApp, EnhancedComponent, {
                ...props,
                router,
              })}
            </AppContainerWithIsomorphicFiberStructure>
          </Body>
        )
      }

      // Always using react concurrent rendering mode with required react version 18.x
      const renderShell = async (
        EnhancedApp: AppType,
        EnhancedComponent: NextComponentType
      ) => {
        const content = renderContent(EnhancedApp, EnhancedComponent)
        return await renderToInitialStream({
          ReactDOMServer,
          element: content,
        })
      }

      const createBodyResult = getTracer().wrap(
        RenderSpan.createBodyResult,
        (initialStream: ReactReadableStream, suffix?: string) => {
          // This must be called inside bodyResult so appWrappers is up to date
          // when `wrapApp` is called.
          const getServerInsertedHTML = async (): Promise<string> => {
            return renderToString(styledJsxInsertedHTML())
          }

          return continueFromInitialStream(initialStream, {
            suffix,
            generateStaticHTML: true,
            getServerInsertedHTML,
            serverInsertedHTMLToHead: false,
          })
        }
      )

      // In edge, we don't support getInitialProps on the Document component.
      const hasDocumentGetInitialProps =
        process.env.NEXT_RUNTIME !== 'edge' &&
        typeof Document.getInitialProps === 'function'

      let bodyResult: (s: string) => Promise<ReadableStream<Uint8Array>>

      // If it has getInitialProps, we will render the shell in `renderPage`.
      // Otherwise we do it right now.
      let documentInitialPropsRes:
        | {}
        | Awaited<ReturnType<typeof loadDocumentInitialProps>>

      if (hasDocumentGetInitialProps) {
        documentInitialPropsRes = await loadDocumentInitialProps(renderShell)
        if (documentInitialPropsRes === null) return null
        const { docProps } = documentInitialPropsRes as any

        // Includes suffix in initial html stream.
        bodyResult = (suffix: string) =>
          createBodyResult(streamFromArray([docProps.html, suffix]))
      } else {
        const stream = await renderShell(App, Component)
        bodyResult = (suffix: string) => createBodyResult(stream, suffix)
        documentInitialPropsRes = {}
      }

      const { docProps } = (documentInitialPropsRes as any) || {}
      const documentElement = (htmlProps: any): JSX.Element => {
        if (process.env.NEXT_RUNTIME === 'edge') {
          return (Document as any)()
        } else {
          return <Document {...htmlProps} {...docProps} />
        }
      }

      let styles
      if (hasDocumentGetInitialProps) {
        styles = docProps.styles
        head = docProps.head
      } else {
        styles = jsxStyleRegistry.styles()
        jsxStyleRegistry.flush()
      }

      return {
        bodyResult,
        documentElement,
        head,
        headTags: [],
        styles,
      }
    }

    // Set the root span attributes for the current route.
    getTracer().getRootSpanAttributes()?.set('next.route', this.definition.page)

    const documentResult = await getTracer().trace(
      RenderSpan.renderDocument,
      {
        spanName: `render route (pages) ${this.definition.page}`,
        attributes: {
          'next.route': this.definition.page,
        },
      },
      async () => renderDocument()
    )
    if (!documentResult) {
      return new RenderResult(null, metadata)
    }

    const dynamicImportsIds = new Set<string | number>()
    const dynamicImports = new Set<string>()

    for (const mod of reactLoadableModules) {
      const manifestItem: ManifestItem = context.manifests.reactLoadable[mod]

      if (manifestItem) {
        dynamicImportsIds.add(manifestItem.id)
        manifestItem.files.forEach((item) => {
          dynamicImports.add(item)
        })
      }
    }

    const hybridAmp = ampState.hybrid
    const docComponentsRendered: DocumentProps['docComponentsRendered'] = {}

    const { customServer, runtimeConfig } = context.renderOpts
    const { buildId, disableOptimizedLoading } = this.renderOpts

    const canonicalBase =
      context.req &&
      !context.renderOpts.ampPath &&
      getRequestMeta(context.req, '__nextStrippedLocale')
        ? `${this.config.amp?.canonicalBase || ''}/${context.renderOpts.locale}`
        : this.config.amp?.canonicalBase || ''

    const htmlProps: HtmlProps = {
      __NEXT_DATA__: {
        props, // The result of getInitialProps
        page: context.renderOpts.page, // The rendered page
        query, // querystring parsed / passed by the user
        buildId, // buildId is used to facilitate caching of page bundles, we send it to the client so that pageloader knows where to load bundles
        assetPrefix:
          this.config.assetPrefix === '' ? undefined : this.config.assetPrefix, // send assetPrefix to the client side when configured, otherwise don't sent in the resulting HTML
        runtimeConfig, // runtimeConfig if provided, otherwise don't sent in the resulting HTML
        nextExport: nextExport === true || undefined, // If this is a page exported by `next export`
        autoExport: isAutoExport === true || undefined, // If this is an auto exported page
        isFallback,
        dynamicIds:
          dynamicImportsIds.size === 0
            ? undefined
            : Array.from(dynamicImportsIds),
        err: context.renderOpts.err
          ? serializeError(this.renderOpts.dev, context.renderOpts.err)
          : undefined, // Error if one happened, otherwise don't sent in the resulting HTML
        gsp: !!getStaticProps || undefined, // whether the page is getStaticProps
        gssp: !!getServerSideProps || undefined, // whether the page is getServerSideProps
        customServer, // whether the user is using a custom server
        gip: typeof getInitialProps === 'function' || undefined, // whether the page has getInitialProps
        appGip: !appHasDefaultGetInitialProps || undefined, // whether the _app has getInitialProps
        locale: context.renderOpts.locale,
        locales: context.renderOpts.locales,
        defaultLocale: context.renderOpts.defaultLocale,
        domainLocales: this.config.i18n?.domains,
        isPreview: isPreview || undefined,
        notFoundSrcPage:
          notFoundSrcPage && this.renderOpts.dev ? notFoundSrcPage : undefined,
      },
      strictNextHead: Boolean(this.config.experimental.strictNextHead),
      buildManifest: filteredBuildManifest,
      docComponentsRendered,
      dangerousAsPath: router.asPath,
      canonicalBase,
      ampPath: context.renderOpts.ampPath || '',
      inAmpMode,
      isDevelopment: this.renderOpts.dev,
      hybridAmp,
      dynamicImports: Array.from(dynamicImports),
      assetPrefix: this.config.assetPrefix,
      // Only enabled in production as development mode has features relying on HMR (style injection for example)
      unstable_runtimeJS:
        process.env.NODE_ENV === 'production'
          ? this.userland.config?.unstable_runtimeJS
          : undefined,
      unstable_JsPreload: this.userland.config?.unstable_JsPreload,
      devOnlyCacheBusterQueryString: metadata.devOnlyCacheBusterQueryString,
      scriptLoader,
      locale: context.renderOpts.locale,
      disableOptimizedLoading,
      head: documentResult.head,
      headTags: documentResult.headTags,
      styles: documentResult.styles,
      crossOrigin: this.config.crossOrigin || undefined,
      optimizeCss: this.config.experimental.optimizeCss,
      optimizeFonts: this.config.optimizeFonts,
      nextConfigOutput: this.config.output,
      nextScriptWorkers: this.config.experimental.nextScriptWorkers,
      runtime: context.renderOpts.runtime,
      largePageDataBytes: this.config.experimental.largePageDataBytes,
      nextFontManifest: context.manifests.nextFont,
    }

    const document = (
      <AmpStateContext.Provider value={ampState}>
        <HtmlContext.Provider value={htmlProps}>
          {documentResult.documentElement(htmlProps)}
        </HtmlContext.Provider>
      </AmpStateContext.Provider>
    )

    const documentHTML = await getTracer().trace(
      RenderSpan.renderToString,
      async () => renderToString(document)
    )

    if (process.env.NODE_ENV !== 'production') {
      const nonRenderedComponents = []
      const expectedDocComponents = ['Main', 'Head', 'NextScript', 'Html']

      for (const comp of expectedDocComponents) {
        if (!(docComponentsRendered as any)[comp]) {
          nonRenderedComponents.push(comp)
        }
      }

      if (nonRenderedComponents.length) {
        const missingComponentList = nonRenderedComponents
          .map((e) => `<${e} />`)
          .join(', ')
        const plural = nonRenderedComponents.length !== 1 ? 's' : ''
        logger.warn(
          `Your custom Document (pages/_document) did not render all the required subcomponent${plural}.\n` +
            `Missing component${plural}: ${missingComponentList}\n` +
            'Read how to fix here: https://nextjs.org/docs/messages/missing-document-component'
        )
      }
    }

    const [renderTargetPrefix, renderTargetSuffix] = documentHTML.split(
      '<next-js-internal-body-render-target></next-js-internal-body-render-target>'
    )

    const prefix: Array<string> = []
    if (!documentHTML.startsWith(DOCTYPE)) {
      prefix.push(DOCTYPE)
    }
    prefix.push(renderTargetPrefix)
    if (inAmpMode) {
      prefix.push('<!-- __NEXT_DATA__ -->')
    }

    const streams = [
      streamFromArray(prefix),
      await documentResult.bodyResult(renderTargetSuffix),
    ]

    const html = await streamToString(chainStreams(streams))

    const processed = await postProcessHTML(
      pathname,
      html,
      {
        optimizeCss: this.config.experimental.optimizeCss,
        optimizeFonts: this.config.optimizeFonts,
        ampSkipValidation: this.config.experimental.amp?.skipValidation,
        ampOptimizerConfig: this.config.experimental.amp?.optimizer,
        ampValidator: this.renderOpts.dev
          ? createAMPValidator(this.config.experimental.amp?.validator)
          : undefined,
        fontManifest: context.manifests.font,
        distDir: context.renderOpts.distDir,
        assetPrefix: this.config.assetPrefix,
      },
      {
        inAmpMode,
        hybridAmp,
      }
    )

    return new RenderResult(processed, metadata)
  }
}

export default PagesRouteModule
