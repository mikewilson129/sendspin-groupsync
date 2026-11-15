/**
 * Player type for Music Assistant players
 */

export interface Player {
  player_id: string;
  name: string;
  type: string;
  available: boolean;
  powered: boolean;
  volume_level: number;
  muted: boolean;
  group_childs?: string[];
  synced_to?: string;
  can_sync_with?: string[];
}
