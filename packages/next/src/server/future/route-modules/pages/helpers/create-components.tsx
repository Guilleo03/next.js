import React from 'react'

const Noop = (): null => null

export function createBody(
  inAmpMode: boolean
): React.FunctionComponent<{ children: JSX.Element }> {
  if (inAmpMode) {
    return ({ children }) => children
  }

  return ({ children }) => <div id="__next">{children}</div>
}

export function createErrorDebug(
  dev: boolean
): React.FunctionComponent<{ error: Error }> | null {
  if (!dev) return null

  return ({ error }: { error: Error }) => {
    // Load the ReactDevOverlay component dynamically to avoid loading it in
    // production.

    // FIXME: (wyattjoh) the types for this are not correct
    const {
      ReactDevOverlay,
    } = require('next/dist/compiled/@next/react-dev-overlay/dist/client')

    return <ReactDevOverlay error={error} />
  }
}

export function createAppContainerWithIsomorphicFiberStructure(
  AppContainer: React.FunctionComponent<{ children: JSX.Element }>,
  context: { dev: boolean | undefined }
): React.FunctionComponent<{ children: JSX.Element }> {
  return ({ children }): JSX.Element => (
    <>
      {/* <Head/> */}
      <Noop />
      <AppContainer>
        <>
          {/* TODO: (wyattjoh) why are these here? */}
          {/* <ReactDevOverlay/> */}
          {context.dev ? (
            <>
              {children}
              <Noop />
            </>
          ) : (
            children
          )}
          {/* <RouteAnnouncer/> */}
          <Noop />
        </>
      </AppContainer>
    </>
  )
}
