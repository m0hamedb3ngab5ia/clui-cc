// Lets node's built-in TypeScript stripping resolve the app's extensionless relative imports.
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (err) {
      if (err?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) {
        return nextResolve(`${specifier}.ts`, context)
      }
      throw err
    }
  },
})
