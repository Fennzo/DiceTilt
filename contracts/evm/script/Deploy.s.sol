// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../src/Treasury.sol";

contract DeployScript {
    function run() external returns (Treasury) {
        return new Treasury();
    }
}
