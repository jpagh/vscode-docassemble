compile:
    npm run compile

build:
    npm run build

test:
    npm run build
    npm test

test-real:
    npm run build
    DOCASSEMBLE_LSP_ENABLE_REAL_TEST=1 npm test

watch:
    npm run watch
