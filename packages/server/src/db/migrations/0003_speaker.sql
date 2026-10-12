-- Whose turn a reply is. Older replies keep null: one call wrote them for the whole cast.
ALTER TABLE `messages` ADD `speaker` text;