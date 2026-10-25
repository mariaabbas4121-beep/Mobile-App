import { act, renderHook } from '@testing-library/react-native';
import { useSubmit } from '../components/auth/useSubmit';

// Two taps in the same tick both reach the handler before React re-renders
// with the button disabled; only the ref guard stops the second one.
test('a second call before the first settles is ignored, even in the same tick', async () => {
  let release: () => void = () => undefined;
  const action = jest.fn(() => new Promise<void>((r) => (release = r)));
  const { result } = await renderHook(() => useSubmit(action));

  let first!: Promise<void>;
  await act(async () => {
    const [run] = result.current;
    first = run();
    void run();
    void run();
  });
  expect(action).toHaveBeenCalledTimes(1);
  expect(result.current[1]).toBe(true);

  await act(async () => {
    release();
    await first;
  });
  expect(result.current[1]).toBe(false);

  // After it settles, a new submission is allowed.
  await act(async () => {
    const [run] = result.current;
    const again = run();
    release();
    await again;
  });
  expect(action).toHaveBeenCalledTimes(2);
});
