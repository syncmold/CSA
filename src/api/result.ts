/** Await a PostgREST request whose data is not needed and throw its error, so callers see the database's refusal. */
export async function check(request: PromiseLike<{ error: unknown }>): Promise<void> {
  const { error } = await request
  if (error) throw error
}
