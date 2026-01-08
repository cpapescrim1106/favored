export type ActionReturn<T> = {
  ok: boolean
  errors?: string | string[] | { path: string, message: string }[]
} & T;
