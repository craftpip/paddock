# Instances

Each subfolder is a self-contained agent instance with its own `docker-compose.yml`.

## Start an instance

```bash
cd instances/<name>
docker compose up -d
```

## Stop an instance

```bash
docker compose down
```

Instances are managed by the Paddock dashboard at `http://localhost:5050`,
or can be operated independently from their folder.
