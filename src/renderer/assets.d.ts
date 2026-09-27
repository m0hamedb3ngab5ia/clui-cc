// Ambient asset modules (no imports here, so these stay global)
declare module '*.png' {
  const src: string
  export default src
}
