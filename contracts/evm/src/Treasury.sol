// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Treasury {
    address public owner;

    event Deposit(address indexed player, uint256 amount, uint256 timestamp);
    event Payout(address indexed recipient, uint256 amount, uint256 timestamp);

    constructor() {
        owner = msg.sender;
    }

    function deposit() external payable {
        require(msg.value > 0, "Treasury: zero amount");
        emit Deposit(msg.sender, msg.value, block.timestamp);
    }

    function payout(address payable recipient, uint256 amount) external {
        require(msg.sender == owner, "Treasury: not owner");
        require(recipient != address(0), "Treasury: zero address");
        require(address(this).balance >= amount, "Treasury: insufficient balance");
        (bool ok,) = recipient.call{value: amount}("");
        require(ok, "Treasury: transfer failed");
        emit Payout(recipient, amount, block.timestamp);
    }

    receive() external payable {
        emit Deposit(msg.sender, msg.value, block.timestamp);
    }
}
