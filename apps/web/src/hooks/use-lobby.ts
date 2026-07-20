import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreateRoomRequest } from "@tabletop/protocol/http";

import { lobbyApi } from "../api/client";

export function useGames() {
  return useQuery({ queryFn: () => lobbyApi.games(), queryKey: ["games"] });
}

export function useRooms(gameId?: string) {
  return useQuery({
    queryFn: () => lobbyApi.rooms(gameId ? { gameId } : {}),
    queryKey: ["rooms", gameId ?? "all"],
    refetchInterval: 10_000,
  });
}

export function useCreateRoom() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRoomRequest) => lobbyApi.createRoom(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["rooms"] }),
  });
}

export function useRoomJoinTicket() {
  return useMutation({
    mutationFn: ({ roomId, password }: { readonly roomId: string; readonly password?: string }) =>
      lobbyApi.roomJoinTicket(roomId, password),
  });
}

export function useInviteJoinTicket(inviteToken: string | undefined) {
  return useQuery({
    enabled: Boolean(inviteToken),
    gcTime: 0,
    queryFn: () => {
      if (!inviteToken) throw new Error("邀请链接缺少令牌");
      return lobbyApi.inviteJoinTicket(inviteToken);
    },
    queryKey: ["invite-join-ticket", inviteToken ?? ""],
    staleTime: Number.POSITIVE_INFINITY,
  });
}
