CREATE INDEX `contact_channels_person_idx` ON `contact_channels` (`person_id`);--> statement-breakpoint
CREATE INDEX `entity_links_entity_idx` ON `entity_links` (`entity_id`);--> statement-breakpoint
CREATE INDEX `files_person_idx` ON `files` (`person_id`);--> statement-breakpoint
CREATE INDEX `files_task_idx` ON `files` (`task_id`);--> statement-breakpoint
CREATE INDEX `interactions_date_idx` ON `interactions` (`date`);--> statement-breakpoint
CREATE INDEX `interactions_person_idx` ON `interactions` (`person_id`);--> statement-breakpoint
CREATE INDEX `subtasks_task_idx` ON `subtasks` (`task_id`);--> statement-breakpoint
CREATE INDEX `tasks_mirror_idx` ON `tasks` (`trello_visible`,`status`);--> statement-breakpoint
CREATE INDEX `tasks_person_idx` ON `tasks` (`person_id`);--> statement-breakpoint
CREATE INDEX `trackable_events_trackable_idx` ON `trackable_events` (`trackable_id`);--> statement-breakpoint
CREATE VIEW `active_tasks` AS select "id", "title", "person_id", "context", "status", "due_date", "completed_at", "origin", "notes", "trello_visible", "created_at" from "tasks" where ("tasks"."trello_visible" = 1 and "tasks"."status" in ('ready', 'in-progress')) order by "tasks"."due_date" asc nulls last;--> statement-breakpoint
CREATE VIEW `person_full` AS 
  select
    p.id, p.slug, p.display_name, p.first_name, p.last_name,
    p.relationship_type, p.employer, p.notes, p.created_at,
    coalesce((
      select json_group_array(json_object('id', c.id, 'kind', c.kind, 'value', c.value,
                                         'primary_flag', c.primary_flag, 'source', c.source))
      from contact_channels c
      where c.person_id = p.id
      order by c.kind, c.id
    ), '[]') as channels_json,
    coalesce((
      select json_group_array(json_object('id', i.id, 'kind', i.kind, 'date', i."date",
                                          'channel', i.channel, 'summary', i.summary))
      from (
        select id, kind, "date", channel, summary
        from interactions
        where person_id = p.id
        order by "date" desc, id desc
        limit 5
      ) i
    ), '[]') as recent_interactions_json
  from people p
  order by p.slug
;