DB_URL=${1:-"postgresql://postgres:postgres@localhost:5432/postgres"}
psql $DB_URL -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" -c "\dt"