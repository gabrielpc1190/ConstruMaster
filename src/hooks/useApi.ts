import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';

export function useList<T>(key: readonly unknown[], path: string) {
  return useQuery<T[]>({ queryKey: key, queryFn: () => api.get<T[]>(path) });
}

export function useItem<T>(key: readonly unknown[], path: string, enabled = true) {
  return useQuery<T>({ queryKey: key, queryFn: () => api.get<T>(path), enabled });
}

export function useCreate<TInput, TOutput = unknown>(path: string, invalidate: readonly unknown[][]) {
  const qc = useQueryClient();
  return useMutation<TOutput, Error, TInput>({
    mutationFn: (body) => api.post<TOutput>(path, body),
    onSuccess: () => invalidate.forEach((k) => qc.invalidateQueries({ queryKey: k })),
  });
}

export function useUpdate<TInput, TOutput = unknown>(pathFn: (id: number | string) => string, invalidate: readonly unknown[][]) {
  const qc = useQueryClient();
  return useMutation<TOutput, Error, { id: number | string; data: TInput }>({
    mutationFn: ({ id, data }) => api.put<TOutput>(pathFn(id), data),
    onSuccess: () => invalidate.forEach((k) => qc.invalidateQueries({ queryKey: k })),
  });
}

export function useDelete(pathFn: (id: number | string) => string, invalidate: readonly unknown[][]) {
  const qc = useQueryClient();
  return useMutation<void, Error, number | string>({
    mutationFn: (id) => api.delete<void>(pathFn(id)),
    onSuccess: () => invalidate.forEach((k) => qc.invalidateQueries({ queryKey: k })),
  });
}
