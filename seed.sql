-- Initial Repository Seeding
-- Replace <GITLAB_PROJECT_ID> and <GITHUB_REPO_FULL_NAME> with your actual values

INSERT INTO repositories (id, name, url, provider, remote_id) 
VALUES (crypto_random_uuid(), 'Frontend Core', 'https://github.com/BrandonLeeLast/Nimbus', 'github', 'BrandonLeeLast/Nimbus');

INSERT INTO repositories (id, name, url, provider, remote_id) 
VALUES (crypto_random_uuid(), 'Backend Worker', 'https://github.com/BrandonLeeLast/Nimbus-Worker', 'github', 'BrandonLeeLast/Nimbus-Worker');

-- If you have GitLab repos, use this format:
-- INSERT INTO repositories (id, name, url, provider, remote_id) 
-- VALUES (crypto_random_uuid(), 'GitLab Service', 'https://gitlab.com/group/repo', 'gitlab', '12345678');
